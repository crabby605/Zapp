set(CORE ${CMAKE_CURRENT_LIST_DIR}/../../core)

idf_component_register(
    SRCS
        port_esp32.c
        hal_esp32.c
        hal_radio_esp32.c
        ${CORE}/repl.c
        ${CORE}/vm.c
        ${CORE}/hal_common.c
        ${CORE}/project_store.c
        ${CORE}/usb_device.c
        ${CORE}/usb_hid.c
        ${CORE}/usb_msc.c
        ${CORE}/uart_ring.c
    INCLUDE_DIRS . ${CORE}
    PRIV_REQUIRES
        esp_driver_gpio esp_driver_ledc esp_driver_i2c esp_driver_spi
        esp_driver_uart esp_driver_rmt esp_adc esp_timer esp_partition
        spi_flash usb esp_wifi esp_netif esp_event nvs_flash
        esp_http_client esp_http_server mbedtls bt
)

# TinyUSB reads its settings from firmware/core/tusb_config.h, shared with the RP2040.
idf_component_get_property(tusb_lib espressif__tinyusb COMPONENT_LIB)
target_include_directories(${tusb_lib} PUBLIC ${CORE})

# The board this build is for, so the firmware knows without being told.
if(ZAPP_BOARD)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE ZAPP_BOARD_NAME="${ZAPP_BOARD}")
endif()
