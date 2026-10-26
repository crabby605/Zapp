#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// The store fills the flash the port gives it (port_store_size): main.zap and
// its bytecode in fixed slots, then every file in modules/ and web/ packed into
// the rest. Files have no size limit of their own — only the space left.
#define PROJECT_STORE_MAIN_MAX      8192
#define PROJECT_STORE_BC_MAX        2048
#define PROJECT_STORE_MAX_MODULES   32       // files across modules/ and web/
#define PROJECT_STORE_NAME_MAX      32       // "web/" or nothing, plus the name, plus a NUL

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

// Files in modules/ and web/ ("bmp280.zappmod", "web/index.html").
size_t project_store_module_count(void);
const char *project_store_module_name(size_t index);

// A stored file's bytes, in place (no copy), or NULL. Valid until the next write.
const uint8_t *project_store_module_data(const char *name, size_t *len);

// Store `len` bytes under `name`, fetched by `read(ctx, offset, out, n)` straight
// into flash's RAM copy — the source never needs to be in one piece. Unchanged
// files cost no flash write. False if it doesn't fit or `read` fails.
typedef bool (*project_store_reader)(void *ctx, size_t offset, uint8_t *out, size_t n);
bool project_store_write_module_from(const char *name, size_t len, project_store_reader read, void *ctx);
bool project_store_delete_module(const char *name);

// Bytes the files in modules/ and web/ share in total.
size_t project_store_files_capacity(void);
