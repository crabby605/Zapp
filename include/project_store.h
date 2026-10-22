#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PROJECT_STORE_MAIN_MAX      8192
#define PROJECT_STORE_BC_MAX        2048
#define PROJECT_STORE_MAX_MODULES   8
#define PROJECT_STORE_NAME_MAX      24
#define PROJECT_STORE_MODULE_MAX    2048

void project_store_init(void);
bool project_store_format(void);

// Register a callback invoked between flash sector writes so the caller
// can service USB or other time-critical peripherals.  Pass NULL to clear.
typedef void (*project_store_idle_fn)(void);
void project_store_set_idle_callback(project_store_idle_fn cb);

size_t project_store_main_size(void);
bool project_store_read_main(char *out, size_t max_len, size_t *actual_len);
bool project_store_write_main(const char *src, size_t len);
bool project_store_main_equals(const char *src, size_t len);

// The board's name (e.g. "xiao_rp2040"), remembered across power-offs.
const char *project_store_board(void);
bool project_store_set_board(const char *name);

bool project_store_read_bc(uint8_t *out, size_t max_len, size_t *actual_len);
bool project_store_write_bc(const uint8_t *src, size_t len);

size_t project_store_module_count(void);
const char *project_store_module_name(size_t index);
bool project_store_read_module(const char *name, uint8_t *out, size_t max_len, size_t *actual_len);
bool project_store_write_module(const char *name, const uint8_t *data, size_t len);
bool project_store_delete_module(const char *name);
