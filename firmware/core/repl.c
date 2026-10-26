#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "config.h"
#include "hal.h"
#include "port.h"
#include "repl.h"
#include "vm.h"
#include "project_store.h"
#include "usb_msc.h"
#include "usb_device.h"
#include "uart_ring.h"

// Bytecode double buffer
#define BC_BUF_SIZE 2048

// Line buffer
// Must hold the longest command: "BC:" + two hex chars per bytecode byte.
#define LINE_BUF_SIZE (BC_BUF_SIZE * 2 + 8)
static char line_buf[LINE_BUF_SIZE];
static uint16_t line_pos = 0;
static bool line_overflow = false;
static volatile bool line_ready = false;

static uint8_t bc_buf_a[BC_BUF_SIZE];
static uint8_t bc_buf_b[BC_BUF_SIZE];
static uint8_t *active_bc = bc_buf_a;
static volatile bool vm_run_in_flight = false;

// Main loop → VM core run requests, and VM core → main loop completion.
static uint8_t * volatile run_buf;
static volatile uint16_t run_len;
static volatile bool run_pending = false;   // set by core 0, taken by core 1
static volatile bool run_done = false;      // set by core 1 when vm_run returns

// Which board this is. The chip can't tell a XIAO from a Pico, so the host
// tells it once ("board xiao_rp2040") and it's kept in flash.
static char board_name[PROJECT_STORE_NAME_MAX] = ZAPP_DEFAULT_BOARD;

// Mode
typedef enum {
    MODE_REPL   = 0,
    MODE_SCRIPT = 1,
    MODE_LLM    = 2,
} ZappMode;

static volatile ZappMode mode = MODE_REPL;
static volatile bool host_opened = false;   // DTR went high: announce identity

// Forward declarations
static void vm_core_entry(void);
static bool handle_line(const char *line);
static void send_identity(void);
static void send_ident_magic(void);
static bool check_magic(uint8_t c);
static void poll_core1_status(void);
static void try_run_persisted_script(void);

// The prompt is for humans; LLM mode is framed by magic bytes instead.
static void prompt(void) {
    if (mode != MODE_LLM) usb_cdc_write("> ");
}

static uint8_t magic_window[4] = {0};

// Returns true when these four bytes completed a magic sequence.
static bool check_magic(uint8_t c) {
    magic_window[0] = magic_window[1];
    magic_window[1] = magic_window[2];
    magic_window[2] = magic_window[3];
    magic_window[3] = c;

    // The identify probe only prints, so it's honoured anywhere, in any mode.
    const uint8_t magic_probe[4] = ZAPP_MAGIC_PROBE;
    if (memcmp(magic_window, magic_probe, 4) == 0) {
        memset(magic_window, 0, 4);
        send_ident_magic();
        return true;
    }

    // Mode-switch magic must start a line (its first three bytes are all that's buffered),
    // so typing "ZPP!" mid-line can't switch modes.
    if (line_pos != 3) return false;

    const uint8_t magic_enter[4] = ZAPP_MAGIC_ENTER;
    const uint8_t magic_exit[4]  = ZAPP_MAGIC_EXIT;

    if (memcmp(magic_window, magic_enter, 4) == 0) {
        mode = MODE_LLM;
        memset(magic_window, 0, 4);
        usb_cdc_write(ZAPP_MAGIC_ACK);
        return true;
    }
    if (memcmp(magic_window, magic_exit, 4) == 0) {
        mode = MODE_REPL;
        memset(magic_window, 0, 4);
        usb_cdc_write(ZAPP_MAGIC_ACK);
        usb_cdc_write("\r\n> ");
        return true;
    }
    return false;
}

static void poll_core1_status(void) {
    // Drain debug ring from Core 1, but cap per iteration so VM
    // print-floods can't starve REPL responses out of the TX FIFO.
    uint8_t c;
    int drain = 0;
    while (drain < 64 && uart_ring_pop(&uart_ring_debug, &c)) {
        usb_cdc_write_char((char)c);
        drain++;
    }
    if (drain > 0) {
        usb_cdc_flush();
    }

    // Only once its output is all out, so "Code done running." can't land
    // in the middle of the program's last line.
    if (vm_run_in_flight && run_done && uart_ring_available(&uart_ring_debug) == 0) {
        run_done = false;
        vm_run_in_flight = false;
        if (mode == MODE_SCRIPT) {
            usb_cdc_writeln("Code done running.");
            mode = MODE_REPL;
            usb_cdc_write("> ");
        }
    }
}

// Hand a program to core 1. The halt flag is cleared here, before the push,
// so a Ctrl+C that lands while core 1 is still starting up isn't lost.
static void start_vm(uint8_t *buf, uint16_t len) {
    active_bc = buf;
    vm_clear_halt();
    run_buf = buf;
    run_len = len;
    run_done = false;
    __atomic_thread_fence(__ATOMIC_SEQ_CST);   // request fields visible before the flag
    run_pending = true;
    port_vm_wake();
    vm_run_in_flight = true;
    if (mode != MODE_LLM) mode = MODE_SCRIPT;   // a run must not drop LLM framing
}

// Ask core 1 to stop and wait for it. Keep draining its output and HID
// queues meanwhile — core 1 may be blocked waiting for room in them. A
// program stuck inside a hardware call never sees the halt flag, so after a
// second core 1 is reset rather than freezing USB with it.
#define STOP_TIMEOUT_US 1000000
static void stop_vm(void) {
    if (!vm_run_in_flight) return;
    vm_request_halt();
    uint64_t deadline = hal_time_us() + STOP_TIMEOUT_US;
    while (vm_run_in_flight) {
        usb_device_task();
        poll_core1_status();
        hal_hid_pump();
        if (vm_run_in_flight && hal_time_us() > deadline) {
            run_pending = false;
            run_done = false;
            vm_run_in_flight = false;
            if (mode != MODE_LLM) mode = MODE_REPL;
            port_vm_relaunch(vm_core_entry);
            usb_cdc_writeln("\r\nProgram didn't stop; restarted the VM core.");
        }
    }
}

static void try_run_persisted_script(void) {
    size_t bc_len = 0;
    if (project_store_read_bc(bc_buf_a, BC_BUF_SIZE, &bc_len) && bc_len > 0) {
        start_vm(bc_buf_a, (uint16_t)bc_len);
    }
}

// VM core

static void vm_core_entry(void) {
    vm_init();

    while (1) {
        while (!run_pending) port_vm_wait();
        __atomic_thread_fence(__ATOMIC_SEQ_CST);
        uint8_t *bc = run_buf;
        uint16_t len = run_len;
        run_pending = false;

        vm_run(bc, len);
        __atomic_thread_fence(__ATOMIC_SEQ_CST);
        run_done = true;
    }
}

// Main loop

void zapp_main(void) {
    port_init();
    hal_board_init();
    uart_ring_init(&uart_ring_debug);
    project_store_init();
    if (project_store_board()[0]) snprintf(board_name, sizeof(board_name), "%s", project_store_board());
    // Service USB between flash sector writes so the host doesn't
    // time out and drop the drive during a save-to-flash cycle.
    project_store_set_idle_callback(usb_device_task);
    usb_device_init();

    port_vm_launch(vm_core_entry);

    // Give the host a second to open the serial port.
    for (int i = 0; i < 200; i++) {
        usb_device_task();
        hal_sleep_ms(5);
    }

    usb_cdc_writeln("");
    usb_cdc_writeln("Zapp v" ZAPP_VERSION " on " ZAPP_CHIP " (" ZAPP_VARIANT ")");
    send_identity();
    usb_cdc_writeln("Type 'help' for commands. Ctrl+C = stop, Ctrl+D = reload.");
    usb_cdc_writeln("");
    try_run_persisted_script();
    if (vm_run_in_flight) {
        usb_cdc_writeln("Running main.zap...");
    }
    prompt();

    while (1) {
        usb_device_task();
        poll_core1_status();
        hal_hid_pump();   // send any HID reports the VM queued

        if (host_opened) {   // a host just opened the port: say who we are
            host_opened = false;
            send_ident_magic();
        }

        // Auto-sync: detect USB drive writes and flush to flash
        if (usb_msc_check_and_sync()) {
            // The board can't compile source, so the running program is unchanged.
            usb_cdc_writeln("\r\nmain.zap saved. Flash it from the Zapp IDE to run your changes.");
            usb_cdc_writeln("ZAPP:SRC_CHANGED");
            prompt();
        }

        while (usb_cdc_available()) {
            int c_int = usb_cdc_read_char();
            if (c_int < 0) break;
            uint8_t c = (uint8_t)c_int;
            
            if (check_magic(c)) {   // mode switch consumed the byte
                line_pos = 0;
                line_overflow = false;
                continue;
            }

            if (c == '\r' || c == '\n') {
                if (line_overflow) {
                    line_overflow = false;
                    line_pos = 0;
                    usb_cdc_writeln("\r\nERR:line_too_long");
                    prompt();
                } else if (line_pos > 0) {
                    line_buf[line_pos] = '\0';
                    line_ready = true;
                    if (mode != MODE_LLM) usb_cdc_write("\r\n");
                    break; // Process this line
                }
            } else if (c == 0x7F || c == 0x08) {
                if (line_pos > 0) {
                    line_pos--;
                    usb_cdc_write("\b \b");
                }
            } else if (c == 0x03) {
                // Ctrl+C: stop running program
                vm_request_halt();
                line_pos = 0;
                usb_cdc_write("\r\n^C\r\n");
                prompt();
            } else if (c == 0x04) {
                // Ctrl+D: soft reload (like CircuitPython)
                stop_vm();
                usb_cdc_writeln("\r\nSoft reload...");
                try_run_persisted_script();
                if (vm_run_in_flight) {
                    usb_cdc_writeln("Running main.zap...");
                } else {
                    usb_cdc_writeln("No bytecode found");
                }
                line_pos = 0;
                prompt();
            } else {
                if (line_pos >= LINE_BUF_SIZE - 1) {
                    line_overflow = true;   // drop the rest, reject on newline
                } else {
                    line_buf[line_pos++] = c;
                    if (mode != MODE_LLM) usb_cdc_write_char((char)c);   // echo
                }
            }
        }

        if (line_ready) {
            line_ready = false;
            bool ok = handle_line(line_buf);
            line_pos = 0;
            if (mode == MODE_LLM) {
                usb_cdc_write(ok ? ZAPP_MAGIC_ACK : ZAPP_MAGIC_ERR);
            } else {
                prompt();
            }
            usb_device_task();  // push response out immediately
        }
        port_idle();
    }
}

static bool handle_line(const char *line) {
    while (*line == ' ' || *line == '\t') line++;
    if (*line == '\0') return true;

    if (strcmp(line, "?") == 0 || strcmp(line, "help") == 0) {
        usb_cdc_writeln("Zapp v" ZAPP_VERSION " - " ZAPP_CHIP " (" ZAPP_VARIANT ")");
        usb_cdc_writeln("Commands:");
        usb_cdc_writeln("  help           show this message");
        usb_cdc_writeln("  identity       board info string");
        usb_cdc_writeln("  reset          hard reboot");
        usb_cdc_writeln("  bootloader     reboot into flashing mode (to install firmware)");
        usb_cdc_writeln("  set pin N high|low");
        usb_cdc_writeln("  read pin N");
        usb_cdc_writeln("  print <text>");
        usb_cdc_writeln("  BC:<hex>       run bytecode and save it as main program");
        usb_cdc_writeln("  RUN:<hex>      run bytecode without saving");
        usb_cdc_writeln("Ctrl+C stop | Ctrl+D reload");
        return true;
    }

    if (strcmp(line, "identity") == 0) {
        send_identity();
        return true;
    }

    if (strcmp(line, "bootloader") == 0) {
        usb_cdc_writeln("rebooting to bootloader...");
        usb_device_task();
        hal_sleep_ms(50);
        port_bootloader();
        return true;
    }

    if (strcmp(line, "reset") == 0) {
        usb_cdc_writeln("resetting...");
        usb_device_task();
        hal_sleep_ms(50);
        port_reboot();
        return true;
    }

    if (strncmp(line, "board ", 6) == 0) {
        const char *name = line + 6;
        size_t n = strlen(name);
        bool ok = n > 0 && n < sizeof(board_name);
        for (size_t i = 0; ok && i < n; i++)
            ok = (name[i] >= 'a' && name[i] <= 'z') || (name[i] >= '0' && name[i] <= '9') || name[i] == '_';
        if (!ok) { usb_cdc_writeln("ERR:bad_board_name"); return false; }
        if (!project_store_set_board(name)) { usb_cdc_writeln("ERR:board_not_saved"); return false; }
        snprintf(board_name, sizeof(board_name), "%s", name);
        usb_cdc_write("board set to: ");
        usb_cdc_writeln(board_name);
        return true;
    }

    // BC: runs and saves as the boot program; RUN: just runs (REPL, one-off tools).
    bool is_bc = strncmp(line, "BC:", 3) == 0;
    if (is_bc || strncmp(line, "RUN:", 4) == 0) {
        stop_vm();

        const char *hex = line + (is_bc ? 3 : 4);
        size_t hex_len = strlen(hex);
        if (hex_len % 2 != 0 || hex_len / 2 > BC_BUF_SIZE) {
            usb_cdc_writeln("ERR:bytecode_too_large");
            return false;
        }

        uint8_t *buf = (active_bc == bc_buf_a) ? bc_buf_b : bc_buf_a;
        uint16_t bc_len = 0;
        for (size_t i = 0; i < hex_len; i += 2) {
            char byte_str[3] = { hex[i], hex[i+1], 0 };
            char *end;
            buf[bc_len++] = (uint8_t)strtol(byte_str, &end, 16);
            if (*end != '\0') {
                usb_cdc_writeln("ERR:bad_hex");
                return false;
            }
        }

        if (is_bc && !project_store_write_bc(buf, bc_len)) {
            usb_cdc_writeln("ERR:flash_write_failed");
            return false;
        }
        start_vm(buf, bc_len);

        usb_cdc_writeln("OK");
        return true;
    }

    if (strncmp(line, "set pin ", 8) == 0) {
        int pin;
        char state_str[16];
        if (sscanf(line + 8, "%d %15s", &pin, state_str) == 2) {
            if (pin < 0 || pin >= ZAPP_GPIO_COUNT) {
                usb_cdc_writeln("ERR:bad_pin");
                return false;
            }
            bool high = (strcmp(state_str, "high") == 0 || strcmp(state_str, "on") == 0);
            hal_gpio_set_output((uint8_t)pin);
            hal_gpio_write((uint8_t)pin, high);
            usb_cdc_writeln("OK");
            return true;
        }
    }

    if (strncmp(line, "read pin ", 9) == 0) {
        int pin = atoi(line + 9);
        if (pin < 0 || pin >= ZAPP_GPIO_COUNT) {
            usb_cdc_writeln("ERR:bad_pin");
            return false;
        }
        hal_gpio_set_input((uint8_t)pin);
        usb_cdc_writeln(hal_gpio_read((uint8_t)pin) ? "high" : "low");
        return true;
    }

    if (strncmp(line, "print ", 6) == 0) {
        usb_cdc_writeln(line + 6);
        return true;
    }

    usb_cdc_write("ERR:unknown_command:");
    usb_cdc_writeln(line);
    return false;
}

// "ZPPI ZAPP:..." on its own line: lets a host tell a Zapp board from any
// other serial device, whatever its USB IDs.
static void send_ident_magic(void) {
    usb_cdc_write("\r\n" ZAPP_MAGIC_IDENT);
    send_identity();
}

// TinyUSB callback: the host opened (DTR high) or closed the port. Runs inside
// tud_task, so just flag it and announce from the main loop.
void tud_cdc_line_state_cb(uint8_t itf, bool dtr, bool rts) {
    (void)itf; (void)rts;
    if (dtr) host_opened = true;
}

static void send_identity(void) {
    char buf[128];
    snprintf(buf, sizeof(buf), "ZAPP:" ZAPP_CHIP ":core:%d:%d:%s", ZAPP_FLASH_KB, ZAPP_RAM_KB, board_name);
    usb_cdc_writeln(buf);
}


