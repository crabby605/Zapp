cmake_minimum_required(VERSION 3.13)

# Board target: "core" (plain RP2040, no radio) or "pico_w" (CYW43 Wi-Fi).
#   cmake .. -DZAPP_BOARD=pico_w
set(ZAPP_BOARD "core" CACHE STRING "Zapp board target: core | pico_w")
if(ZAPP_BOARD STREQUAL "pico_w")
    set(PICO_BOARD pico_w)
endif()

set(PICO_SDK_PATH ${CMAKE_CURRENT_LIST_DIR}/pico-sdk CACHE PATH "Pico SDK")
include(pico_sdk_import.cmake)
project(zapp C CXX ASM)
set(CMAKE_C_STANDARD 11)
pico_sdk_init()

set(CORE ${CMAKE_CURRENT_LIST_DIR}/../core)
if(ZAPP_BOARD STREQUAL "pico_w")
    set(ZAPP_RADIO_SRC hal_radio_cyw43.c hal_ble_cyw43.c)
else()
    set(ZAPP_RADIO_SRC ${CORE}/hal_radio_none.c)
endif()
add_executable(zapp
    port_rp2040.c
    hal_rp2040.c
    ${CORE}/repl.c
    ${CORE}/vm.c
    ${CORE}/hal_common.c
    ${CORE}/project_store.c
    ${CORE}/usb_device.c
    ${CORE}/usb_hid.c
    ${CORE}/usb_msc.c
    ${CORE}/uart_ring.c
    ${ZAPP_RADIO_SRC}
)
target_include_directories(zapp PRIVATE ${CMAKE_CURRENT_LIST_DIR} ${CORE})
pico_generate_pio_header(zapp ${CMAKE_CURRENT_LIST_DIR}/ws2812.pio)
target_link_libraries(zapp
    pico_stdlib
    pico_multicore
    hardware_gpio
    hardware_pwm
    hardware_i2c
    hardware_spi
    hardware_uart
    hardware_adc
    hardware_pio
    hardware_dma
    hardware_flash
    hardware_sync
    pico_flash
    pico_unique_id
    tinyusb_device
    tinyusb_board
)
if(ZAPP_BOARD STREQUAL "pico_w")
    target_link_libraries(zapp
        pico_cyw43_arch_lwip_threadsafe_background
        pico_lwip_http
        pico_btstack_ble
        pico_btstack_cyw43
    )
    target_compile_definitions(zapp PRIVATE ZAPP_HAS_RADIO=1)
    # Turns zapp_ble.gatt into zapp_ble.h; the import path picks up
    # btstack's own nordic_spp_service.gatt.
    pico_btstack_make_gatt_header(zapp PRIVATE
        ${CMAKE_CURRENT_LIST_DIR}/zapp_ble.gatt
        ${PICO_SDK_PATH}/lib/btstack/src/ble/gatt-service
    )
endif()

pico_add_extra_outputs(zapp)
pico_enable_stdio_usb(zapp 0)
pico_enable_stdio_uart(zapp 0)
