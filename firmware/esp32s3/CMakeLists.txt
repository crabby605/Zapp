cmake_minimum_required(VERSION 3.16)

# One build per board, like CircuitPython: boards/<name>/sdkconfig.board says the
# board's flash size and PSRAM, on top of sdkconfig.defaults.
#   idf.py -B build-<name> -D ZAPP_BOARD=<name> build
# Without ZAPP_BOARD you get a build for any S3 with 4MB flash and no PSRAM.
set(ZAPP_BOARD "" CACHE STRING "Board, a folder in boards/")
set(SDKCONFIG_DEFAULTS "${CMAKE_CURRENT_LIST_DIR}/sdkconfig.defaults")
if(ZAPP_BOARD)
    set(ZAPP_BOARD_CONFIG "${CMAKE_CURRENT_LIST_DIR}/boards/${ZAPP_BOARD}/sdkconfig.board")
    if(NOT EXISTS "${ZAPP_BOARD_CONFIG}")
        message(FATAL_ERROR "No board '${ZAPP_BOARD}' in firmware/esp32s3/boards/")
    endif()
    list(APPEND SDKCONFIG_DEFAULTS "${ZAPP_BOARD_CONFIG}")
endif()
# Each build folder keeps its own settings, so boards don't overwrite each other.
set(SDKCONFIG "${CMAKE_BINARY_DIR}/sdkconfig")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(zapp)
