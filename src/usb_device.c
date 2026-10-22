#include "tusb.h"
#include "usb_device.h"
#include "usb_hid.h"
#include "usb_msc.h"
#include <string.h>
#include "pico/unique_id.h"

#define _PID_MAP(itf, n)  ((CFG_TUD_##itf) << (n))
#define USB_PID           (0x4000 | _PID_MAP(CDC, 0) | _PID_MAP(MSC, 1))
// ponytail: TinyUSB example VID, shared with other gadgets; hosts match the
// full VID:PID (findZappPorts). Free PID at raspberrypi/usb-pid if that ever clashes.
#define USB_VID           0xCafe
#define USB_BCD           0x0200

tusb_desc_device_t const desc_device = {
    .bLength = sizeof(tusb_desc_device_t),
    .bDescriptorType = TUSB_DESC_DEVICE,
    .bcdUSB = USB_BCD,
    .bDeviceClass = TUSB_CLASS_MISC,
    .bDeviceSubClass = MISC_SUBCLASS_COMMON,
    .bDeviceProtocol = MISC_PROTOCOL_IAD,
    .bMaxPacketSize0 = CFG_TUD_ENDPOINT0_SIZE,
    .idVendor = USB_VID,
    .idProduct = USB_PID,
    .bcdDevice = 0x0100,
    .iManufacturer = 0x01,
    .iProduct = 0x02,
    .iSerialNumber = 0x03,
    .bNumConfigurations = 0x01
};

uint8_t const *tud_descriptor_device_cb(void) {
    return (uint8_t const *) &desc_device;
}

enum {
    ITF_NUM_CDC = 0,
    ITF_NUM_CDC_DATA,
    ITF_NUM_MSC,
    ITF_NUM_HID,
    ITF_NUM_TOTAL
};

#define EPNUM_CDC_NOTIF   0x81
#define EPNUM_CDC_OUT     0x02
#define EPNUM_CDC_IN      0x82
#define EPNUM_MSC_OUT     0x03
#define EPNUM_MSC_IN      0x83
#define EPNUM_HID_IN      0x84

// Report ids let one HID endpoint carry both a keyboard and a mouse.
uint8_t const desc_hid_report[] = {
    TUD_HID_REPORT_DESC_KEYBOARD(HID_REPORT_ID(ZAPP_HID_REPORT_KEYBOARD)),
    TUD_HID_REPORT_DESC_MOUSE(HID_REPORT_ID(ZAPP_HID_REPORT_MOUSE)),
};

uint8_t const *tud_hid_descriptor_report_cb(uint8_t instance) {
    (void) instance;
    return desc_hid_report;
}

#define CONFIG_TOTAL_LEN (TUD_CONFIG_DESC_LEN + TUD_CDC_DESC_LEN + \
                          TUD_MSC_DESC_LEN + TUD_HID_DESC_LEN)

uint8_t const desc_fs_configuration[] = {
    TUD_CONFIG_DESCRIPTOR(1, ITF_NUM_TOTAL, 0, CONFIG_TOTAL_LEN, 0x00, 100),
    TUD_CDC_DESCRIPTOR(ITF_NUM_CDC, 4, EPNUM_CDC_NOTIF, 8, EPNUM_CDC_OUT, EPNUM_CDC_IN, 64),
    TUD_MSC_DESCRIPTOR(ITF_NUM_MSC, 5, EPNUM_MSC_OUT, EPNUM_MSC_IN, 64),
    TUD_HID_DESCRIPTOR(ITF_NUM_HID, 6, HID_ITF_PROTOCOL_NONE,
                       sizeof(desc_hid_report), EPNUM_HID_IN, 16, 10),
};

uint8_t const *tud_descriptor_configuration_cb(uint8_t index) {
    (void) index;
    return desc_fs_configuration;
}

enum {
    STRID_LANGID = 0,
    STRID_MANUFACTURER,
    STRID_PRODUCT,
    STRID_SERIAL,
};

char const *string_desc_arr[] = {
    (const char[]) { 0x09, 0x04 },
    "Zapp",
    "Zapp Core",
    NULL,           // serial: filled from the flash chip's unique id
    "Zapp CDC",
    "Zapp Drive",
    "Zapp HID",
};

static uint16_t _desc_str[32 + 1];

uint16_t const *tud_descriptor_string_cb(uint8_t index, uint16_t langid) {
    (void) langid;
    size_t chr_count;

    switch (index) {
        case STRID_LANGID:
            _desc_str[1] = 0x0409;
            chr_count = 1;
            break;
        default:
            if (!(index < sizeof(string_desc_arr) / sizeof(string_desc_arr[0]))) return NULL;
            const char *str = string_desc_arr[index];
            // Per-board serial, so two boards don't fight over one COM port/drive.
            static char serial[2 * PICO_UNIQUE_BOARD_ID_SIZE_BYTES + 1];
            if (index == STRID_SERIAL) {
                pico_get_unique_board_id_string(serial, sizeof(serial));
                str = serial;
            }
            chr_count = strlen(str);
            if (chr_count > 32) chr_count = 32;
            for (size_t i = 0; i < chr_count; i++) {
                _desc_str[1 + i] = str[i];
            }
            break;
    }

    _desc_str[0] = (uint16_t)((TUSB_DESC_STRING << 8) | (2 * chr_count + 2));
    return _desc_str;
}

// Device lifecycle

void usb_device_init(void) {
    usb_msc_init_disk();
    tusb_init();
}

void usb_device_task(void) {
    tud_task();
}

bool usb_device_mounted(void) {
    return tud_mounted();
}

// CDC serial

void usb_cdc_write(const char *s) {
    uint32_t len = (uint32_t)strlen(s);
    uint32_t written = 0;
    while (written < len) {
        uint32_t avail = tud_cdc_write_available();
        if (avail == 0) {
            // FIFO full — flush and give TinyUSB a chance to transmit
            tud_cdc_write_flush();
            tud_task();
            avail = tud_cdc_write_available();
            if (avail == 0) break;  // CDC not connected, bail out
        }
        uint32_t chunk = len - written;
        if (chunk > avail) chunk = avail;
        uint32_t n = tud_cdc_write(s + written, chunk);
        written += n;
        if (n == 0) break;  // safety: avoid spin if write fails
    }
    tud_cdc_write_flush();
}

void usb_cdc_writeln(const char *s) {
    usb_cdc_write(s);
    usb_cdc_write("\r\n");
}

void usb_cdc_write_char(char c) {
    if (tud_cdc_write_available() == 0) {
        tud_cdc_write_flush();
        tud_task();
    }
    tud_cdc_write_char(c);
    tud_cdc_write_flush();
}

void usb_cdc_flush(void) {
    tud_cdc_write_flush();
}

bool usb_cdc_available(void) {
    return tud_cdc_available() > 0;
}

int usb_cdc_read_char(void) {
    return tud_cdc_available() ? tud_cdc_read_char() : -1;
}
