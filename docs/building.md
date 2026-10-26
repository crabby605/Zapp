# Building

## Firmware

One shared core (`firmware/core`: VM, REPL, USB drive, flash store) and one
folder per chip. A port implements `hal.h`, `hal_radio.h` and `port.h`.

**RP2040 / Pico W** (Pico SDK, pulled in as a submodule):

```bash
git submodule update --init --recursive
cd firmware/rp2040
cmake -B build && make -C build -j8                              # plain RP2040
cmake -B build-picow -DZAPP_BOARD=pico_w && make -C build-picow -j8  # Pico W, Wi-Fi + BLE
```

Output: `build/zapp.uf2` — hold BOOTSEL on your Pico, drag the file onto the drive.

**ESP32-S3** (ESP-IDF 5.5, Wi-Fi + BLE built in). One build per board, like
CircuitPython: `firmware/esp32s3/boards/<board>/sdkconfig.board` sets that
board's flash size and PSRAM (taken from CircuitPython's `mpconfigboard.mk`),
and the firmware knows which board it is.

```bash
. ~/esp/esp-idf/export.sh
cd firmware/esp32s3
idf.py -B build-xiao_esp32s3 -D ZAPP_BOARD=xiao_esp32s3 build
idf.py -B build-xiao_esp32s3 -p /dev/cu.usbmodem* flash   # hold BOOT, tap RESET first if it isn't in download mode
```

| Board build | PSRAM | Flash |
|---|---|---|
| `esp32s3_devkitc` (DevKitC-1 N8) | none | 8MB |
| `esp32s3_devkitc_n8r8` | 8MB octal | 8MB |
| `xiao_esp32s3` | 8MB octal | 8MB |
| `feather_esp32s3`, `qtpy_esp32s3` | 2MB quad (also runs on the no-PSRAM versions) | 4MB |
| `esp32s3_zero`, `lolin_s3_mini` | 2MB quad | 4MB |

Plain `idf.py build` (no `ZAPP_BOARD`) gives a build for any S3 with no PSRAM.
Octal and quad PSRAM are wired differently, so a board needs its own build.

TinyUSB comes from Espressif's component registry on the first build. Once Zapp
is running, the board's native USB port is the Zapp drive and REPL; type
`bootloader` in the REPL to drop back into download mode for the next flash.
Boards with Adafruit's TinyUF2 bootloader (Feather / QT Py S3) can take
`idf.py -B build-<board> uf2-app` → `uf2-app.bin` instead: double-tap reset, drag it on.

**How much a board stores.** `main.zap` gets 8KB; everything in `modules/` and
`web/` shares the rest, with no limit per file and up to 32 files. A board's
`boot_out.txt` says its number, and the IDE checks against it.

The board measures its PSRAM when it starts and sizes these from it (the
drive gets half, the store a quarter, within FAT12's and the partition's limits).
What it can't measure is the PSRAM's type, octal or quad — that has to be
right before it can talk to the chip at all, hence one build per board.

| Board | Shared by `modules/` and `web/` | Drive |
|---|---|---|
| RP2040 / Pico W, ESP32-S3 without PSRAM | about 21KB | 48KB |
| ESP32-S3 with 2MB PSRAM | about 500KB | 1MB |
| ESP32-S3 with 8MB PSRAM | about 1MB | about 2MB |

Moving a board between these sizes (e.g. flashing a PSRAM build) starts its
store fresh.

## Compiler (TypeScript)

```bash
cd compiler
npm install
npm run build    # compile to JS
npm run check    # type-check only
```

## Emulator

The firmware VM also builds for the host, linked against a virtual board, so
programs can be run and tested without hardware:

```bash
make -C emulator
emulator/zapp-emu --quiet "BC:011901110000012C011900110000012CFF"
# gpio 25=1
# gpio 25=0
```

Flags: `--gpio 15=1` presets an input pin, `--quiet` hides bus chatter,
`--no-radio` fakes a board without a radio, `--fb` dumps the display framebuffer
as hex, `--no-display` skips the ASCII framebuffer dump.

The virtual board answers I2C like the real parts: the **DS3231** returns the
host clock, the **BMP280** ~21 °C, the **MPU6050** a board lying flat, and the
**SSD1306** framebuffer is rendered. So `examples/clock.zap` prints the actual
time with no hardware attached.

## Tests

```bash
npm install      # once, in the repo root
npm test         # 113 tests: compiler, opcode-table sync, end-to-end VM runs
```

`tests/vm.test.ts` compiles Zapp source, runs the resulting bytecode through the
real VM in the emulator, and asserts on the hardware trace — so the compiler and
the firmware are checked against each other, not just against themselves.
