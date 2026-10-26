# Radios (Wi-Fi + Bluetooth LE)

Wi-Fi and BLE are implemented for the **Pico W** (Infineon CYW43439) and every
**ESP32-S3** board. The S3 firmware always has them; the Pico W needs its own build:

```bash
cd firmware/rp2040
cmake -B build-picow -DZAPP_BOARD=pico_w && make -C build-picow -j8
```

```zap
connect wifi to "your-network" with "your-password"   # leave out `with` for an open network

if wifi connected:
    print "ip " + wifi ip
    text page = http get "http://example.com/api"
    print page
```

`connect wifi to "…" with "…"`, `wifi connected`, `wifi ip`, `http get "url"` and
`http post "url" "body"` are the client surface.

## Access point and web pages

```zap
start wifi "Zapp" with "password"   # leave out `with` for an open network
serve web
print "open http://" + wifi ip      # 192.168.4.1
```

`start wifi` makes the board its own network and hands out addresses to
phones and laptops that join. `serve web` serves the drive's `web/` folder on
port 80: `/` is `web/index.html`, `/style.css` is `web/style.css`. It works on
either network, joined or started. Pages can be any size the board's storage
holds (see above), with names up to 27 characters; the access point takes 8 clients.
 On a board with no radio the VM
stops with `Hardware Error: this board has no radio` instead of doing nothing
quietly, and the emulator reproduces both cases (`--no-radio` fakes a plain
RP2040), so radio programs are testable without hardware.

## Bluetooth LE

The board advertises as a BLE peripheral running a **Nordic UART service**, so
nRF Connect, LightBlue and Bluefruit Connect talk to it with no extra work:

```zap
advertise "zapp-sensor"

repeat forever:
    if ble connected:
        notify "temp 21"              # any value; sent as text

        text command = ble message    # what the phone sent, or nil
        if command == "led on":
            set pin 25 high
    sleep 2s
```

Implementation: `firmware/core/hal_radio.h` is the interface.
`firmware/rp2040/hal_radio_cyw43.c` (Wi-Fi, lwIP in threadsafe-background mode
because the VM runs on core 1) and `hal_ble_cyw43.c` (BLE, btstack on the CYW43
async context) are the Pico W backends, with the GATT database in
`zapp_ble.gatt`. `firmware/esp32s3/main/hal_radio_esp32.c` is the ESP32-S3
backend (esp_wifi, esp_http_client, esp_http_server, NimBLE).
`firmware/core/hal_radio_none.c` is every board without a radio. Opcodes live
in the `0xF0` block.

## What each chip can actually do

| Target | Radio | Status here |
|--------|-------|-------------|
| RP2040 (Pico, XIAO, Feather) | none | `hal_radio_none.c` — fails loudly |
| **Pico W / Pico 2 W** | 2.4GHz Wi-Fi 4 (802.11n) + BLE 5.2, CYW43439 | **Wi-Fi and BLE both built** |
| **ESP32-S3** | 2.4GHz Wi-Fi 4 + BLE 5 | **Wi-Fi, BLE, HTTPS and POST all built** (`firmware/esp32s3`) |
| ESP32-C3 | 2.4GHz Wi-Fi 4 + BLE 5 | same port minus native USB (it has none), so no drive or HID |
| ESP32-C5 | 2.4 **and 5GHz** Wi-Fi 6 + BLE 5 + 802.15.4 | same port; in mass production since April 2025, ESP-IDF ≥ 5.4 |
| nRF52/53 | BLE 5.3, Thread, Matter | port onto the nRF Connect SDK |
| nRF7002 companion | Wi-Fi 6, dual-band 2.4/5GHz | host MCU + nRF70 driver over SPI |

Two things worth being precise about: **no 5GHz on any Pico** — the CYW43439 is
2.4GHz only, so dual-band means moving to ESP32-C5 or an nRF7002 companion. And
**nothing here reaches Wi-Fi 6E/7**: the nRF7002 is Wi-Fi 6 dual-band and does
not do 6GHz, and 6E parts are outside what this firmware targets.

The S3 backend has none of the Pico W's HTTP limits below: `http post` works,
`https://` works (ESP-IDF's certificate bundle), and the access point uses
ESP-IDF's own DHCP server. Responses are still 63 bytes, as that's a Zapp string.

## Known limits of the Pico W backend

- `http get` only; `http post` returns a clear error on hardware (it works in
  the emulator). POST needs httpc's custom-request path.
- `http://` only — HTTPS needs mbedtls + altcp_tls linked in, which roughly
  doubles the flash cost.
- Response bodies are truncated to 63 bytes, because that's a Zapp string.
- One request in flight at a time.
- BLE is peripheral-only: one connection, one pending inbound message, no
  pairing or encryption (anything in range can connect). Messages are 63 bytes.
- The advertised name is dynamic, but the GATT device-name characteristic is
  fixed at "Zapp" — `gap_set_local_name` is a classic-Bluetooth call that isn't
  linked into an LE-only build.
