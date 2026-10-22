#include "project_store.h"

#include <string.h>

#include "hardware/flash.h"
#include "hardware/sync.h"
#include "pico/flash.h"
#include "pico/stdlib.h"

#define PROJECT_STORE_MAGIC 0x5A505246u
#define PROJECT_STORE_VERSION 4u
#define PROJECT_STORE_REGION_SIZE (32 * 1024u)
// Fixed layout inside the data area: main source, then bytecode, then modules.
// Fixed (not packed) so re-saving a main.zap of a different length can't move
// the bytecode out from under a previously stored offset.
#define PROJECT_STORE_BC_OFFSET PROJECT_STORE_MAIN_MAX
#define PROJECT_STORE_MODULE_OFFSET (PROJECT_STORE_MAIN_MAX + PROJECT_STORE_BC_MAX)
#define PROJECT_STORE_FLASH_OFFSET (PICO_FLASH_SIZE_BYTES - PROJECT_STORE_REGION_SIZE)

typedef struct {
    char name[PROJECT_STORE_NAME_MAX];
    uint32_t offset;
    uint32_t length;
} ProjectStoreModuleEntry;

typedef struct {
    uint32_t magic;
    uint32_t version;
    uint32_t main_len;
    uint32_t bc_len;
    uint32_t module_count;
    char board[PROJECT_STORE_NAME_MAX];   // which board this is, set by the host ("" = not told yet)
    ProjectStoreModuleEntry modules[PROJECT_STORE_MAX_MODULES];
    uint8_t data[];
} ProjectStoreHeader;

static uint8_t project_store_shadow[PROJECT_STORE_REGION_SIZE];
static bool project_store_loaded = false;

static const uint8_t *project_store_flash_base(void) {
    return (const uint8_t *)(XIP_BASE + PROJECT_STORE_FLASH_OFFSET);
}

static ProjectStoreHeader *project_store_header(void) {
    return (ProjectStoreHeader *)project_store_shadow;
}

static const ProjectStoreHeader *project_store_header_const(void) {
    return (const ProjectStoreHeader *)project_store_shadow;
}

static size_t project_store_header_size(void) {
    return sizeof(ProjectStoreHeader);
}

static size_t project_store_data_capacity(void) {
    return PROJECT_STORE_REGION_SIZE - project_store_header_size();
}

static void project_store_reload_shadow(void) {
    memcpy(project_store_shadow, project_store_flash_base(), PROJECT_STORE_REGION_SIZE);
    project_store_loaded = true;
}

static bool project_store_is_valid(const ProjectStoreHeader *header) {
    return header->magic == PROJECT_STORE_MAGIC &&
           header->version == PROJECT_STORE_VERSION &&
           header->module_count <= PROJECT_STORE_MAX_MODULES &&
           header->main_len <= PROJECT_STORE_MAIN_MAX &&
           header->bc_len <= PROJECT_STORE_BC_MAX &&
           PROJECT_STORE_MODULE_OFFSET <= project_store_data_capacity();
}

// Per-sector flash writes (USB-safe)
// Instead of erasing 32KB at once (~400ms USB blackout), we write one 4KB
// sector at a time with an idle callback between each.  Each sector erase is
// ~45ms — well under USB timeout.  Unchanged sectors are skipped entirely.

static project_store_idle_fn idle_cb = NULL;

void project_store_set_idle_callback(project_store_idle_fn cb) {
    idle_cb = cb;
}

typedef struct {
    const uint8_t *src;
    uint32_t flash_offset;
} SectorWriteParams;

static void flash_write_one_sector(void *param) {
    SectorWriteParams *p = (SectorWriteParams *)param;
    flash_range_erase(p->flash_offset, FLASH_SECTOR_SIZE);
    for (size_t page = 0; page < FLASH_SECTOR_SIZE / FLASH_PAGE_SIZE; page++) {
        flash_range_program(
            p->flash_offset + page * FLASH_PAGE_SIZE,
            p->src + page * FLASH_PAGE_SIZE,
            FLASH_PAGE_SIZE
        );
    }
}

static bool project_store_commit_shadow(void) {
    const uint8_t *flash = project_store_flash_base();

    for (size_t s = 0; s < PROJECT_STORE_REGION_SIZE / FLASH_SECTOR_SIZE; s++) {
        size_t offset = s * FLASH_SECTOR_SIZE;

        // Skip sectors that haven't changed — saves time + flash wear
        if (memcmp(project_store_shadow + offset, flash + offset, FLASH_SECTOR_SIZE) == 0) {
            continue;
        }

        SectorWriteParams params = {
            .src = project_store_shadow + offset,
            .flash_offset = PROJECT_STORE_FLASH_OFFSET + offset,
        };
        if (flash_safe_execute(flash_write_one_sector, &params, UINT32_MAX) != PICO_OK) {
            return false;
        }

        // Service USB between sector writes to prevent host timeout
        if (idle_cb) idle_cb();
    }

    return true;
}

static bool project_store_ensure_loaded(void) {
    if (!project_store_loaded) {
        project_store_reload_shadow();
    }

    if (!project_store_is_valid(project_store_header_const())) {
        return project_store_format();
    }

    return true;
}

static uint8_t *project_store_data_base(void) {
    return project_store_shadow + project_store_header_size();
}

static const uint8_t *project_store_data_base_const(void) {
    return project_store_shadow + project_store_header_size();
}

static size_t project_store_find_module(const char *name) {
    const ProjectStoreHeader *header = project_store_header_const();
    for (size_t i = 0; i < header->module_count; i++) {
        if (strncmp(header->modules[i].name, name, PROJECT_STORE_NAME_MAX) == 0) {
            return i;
        }
    }
    return PROJECT_STORE_MAX_MODULES;
}

static bool project_store_append_blob(uint32_t *offset_out, const uint8_t *data, size_t len) {
    ProjectStoreHeader *header = project_store_header();
    size_t max_end = PROJECT_STORE_MODULE_OFFSET;

    for (size_t i = 0; i < header->module_count; i++) {
        size_t end = header->modules[i].offset + header->modules[i].length;
        if (end > max_end) {
            max_end = end;
        }
    }

    if (max_end + len > project_store_data_capacity()) {
        return false;
    }

    memcpy(project_store_data_base() + max_end, data, len);
    *offset_out = (uint32_t)max_end;
    return true;
}

void project_store_init(void) {
    project_store_reload_shadow();
    (void)project_store_ensure_loaded();
}

bool project_store_format(void) {
    memset(project_store_shadow, 0xFF, sizeof(project_store_shadow));
    ProjectStoreHeader *header = project_store_header();
    memset(header, 0, project_store_header_size());
    header->magic = PROJECT_STORE_MAGIC;
    header->version = PROJECT_STORE_VERSION;
    header->main_len = 0;
    header->bc_len = 0;
    header->module_count = 0;
    project_store_loaded = true;
    return project_store_commit_shadow();
}

size_t project_store_main_size(void) {
    if (!project_store_ensure_loaded()) {
        return 0;
    }
    return project_store_header_const()->main_len;
}

bool project_store_read_main(char *out, size_t max_len, size_t *actual_len) {
    if (!project_store_ensure_loaded()) {
        return false;
    }

    const ProjectStoreHeader *header = project_store_header_const();
    if (actual_len) {
        *actual_len = header->main_len;
    }

    if (!out || max_len == 0) {
        return header->main_len == 0;
    }

    size_t copy_len = header->main_len;
    if (copy_len >= max_len) {
        copy_len = max_len - 1;
    }

    memcpy(out, project_store_data_base_const(), copy_len);
    out[copy_len] = '\0';
    return copy_len == header->main_len;
}

bool project_store_write_main(const char *src, size_t len) {
    if (!src || len > PROJECT_STORE_MAIN_MAX) {
        return false;
    }
    if (!project_store_ensure_loaded()) {
        return false;
    }

    ProjectStoreHeader *header = project_store_header();
    memcpy(project_store_data_base(), src, len);
    header->main_len = (uint32_t)len;
    return project_store_commit_shadow();
}

bool project_store_read_bc(uint8_t *out, size_t max_len, size_t *actual_len) {
    if (!project_store_ensure_loaded()) {
        return false;
    }

    const ProjectStoreHeader *header = project_store_header_const();
    if (actual_len) {
        *actual_len = header->bc_len;
    }

    if (!out || max_len == 0) {
        return header->bc_len == 0;
    }

    if (header->bc_len > max_len) {
        return false;
    }

    memcpy(out, project_store_data_base_const() + PROJECT_STORE_BC_OFFSET, header->bc_len);
    return true;
}

bool project_store_write_bc(const uint8_t *src, size_t len) {
    if (!src || len > PROJECT_STORE_BC_MAX) {
        return false;
    }
    if (!project_store_ensure_loaded()) {
        return false;
    }

    ProjectStoreHeader *header = project_store_header();
    memcpy(project_store_data_base() + PROJECT_STORE_BC_OFFSET, src, len);
    header->bc_len = (uint32_t)len;
    return project_store_commit_shadow();
}

const char *project_store_board(void) {
    if (!project_store_ensure_loaded()) return "";
    const char *b = project_store_header_const()->board;
    return memchr(b, 0, PROJECT_STORE_NAME_MAX) ? b : "";
}

bool project_store_set_board(const char *name) {
    if (!project_store_ensure_loaded() || strlen(name) >= PROJECT_STORE_NAME_MAX) return false;
    ProjectStoreHeader *header = project_store_header();
    if (strcmp(header->board, name) == 0) return true;   // no flash write for no change
    memset(header->board, 0, sizeof(header->board));
    strcpy(header->board, name);
    return project_store_commit_shadow();
}

size_t project_store_module_count(void) {
    if (!project_store_ensure_loaded()) {
        return 0;
    }
    return project_store_header_const()->module_count;
}

const char *project_store_module_name(size_t index) {
    if (!project_store_ensure_loaded()) {
        return NULL;
    }
    const ProjectStoreHeader *header = project_store_header_const();
    if (index >= header->module_count) {
        return NULL;
    }
    return header->modules[index].name;
}

bool project_store_read_module(const char *name, uint8_t *out, size_t max_len, size_t *actual_len) {
    if (!name || !project_store_ensure_loaded()) {
        return false;
    }

    size_t index = project_store_find_module(name);
    if (index >= PROJECT_STORE_MAX_MODULES) {
        return false;
    }

    const ProjectStoreModuleEntry *entry = &project_store_header_const()->modules[index];
    if (actual_len) {
        *actual_len = entry->length;
    }
    if (!out) {
        return true;
    }
    if (entry->length > max_len) {
        return false;
    }

    memcpy(out, project_store_data_base_const() + entry->offset, entry->length);
    return true;
}

// Drop module `index` from the shadow and close the gap its blob leaves, so
// rewriting a module reuses space instead of appending forever.
static void project_store_remove_module(size_t index) {
    ProjectStoreHeader *header = project_store_header();
    uint32_t off = header->modules[index].offset;
    uint32_t len = header->modules[index].length;
    size_t end = PROJECT_STORE_MODULE_OFFSET;
    for (size_t i = 0; i < header->module_count; i++) {
        size_t e = header->modules[i].offset + header->modules[i].length;
        if (e > end) end = e;
    }
    uint8_t *data = project_store_data_base();
    memmove(data + off, data + off + len, end - (off + len));
    for (size_t i = 0; i < header->module_count; i++) {
        if (header->modules[i].offset > off) header->modules[i].offset -= len;
    }
    memmove(&header->modules[index], &header->modules[index + 1],
            (header->module_count - index - 1) * sizeof(header->modules[0]));
    header->module_count--;
}

bool project_store_delete_module(const char *name) {
    if (!name || !project_store_ensure_loaded()) {
        return false;
    }
    size_t index = project_store_find_module(name);
    if (index >= PROJECT_STORE_MAX_MODULES) {
        return true;
    }
    project_store_remove_module(index);
    return project_store_commit_shadow();
}

bool project_store_main_equals(const char *src, size_t len) {
    if (!project_store_ensure_loaded()) {
        return false;
    }
    return project_store_header_const()->main_len == len &&
           memcmp(project_store_data_base_const(), src, len) == 0;
}

bool project_store_write_module(const char *name, const uint8_t *data, size_t len) {
    if (!name || !data || len > PROJECT_STORE_MODULE_MAX) {
        return false;
    }
    if (!project_store_ensure_loaded()) {
        return false;
    }

    ProjectStoreHeader *header = project_store_header();
    size_t index = project_store_find_module(name);
    if (index < PROJECT_STORE_MAX_MODULES) {
        const ProjectStoreModuleEntry *e = &header->modules[index];
        if (e->length == len &&
            memcmp(project_store_data_base_const() + e->offset, data, len) == 0) {
            return true;   // unchanged — skip the flash write
        }
        project_store_remove_module(index);
        index = PROJECT_STORE_MAX_MODULES;
    }
    if (index >= PROJECT_STORE_MAX_MODULES) {
        if (header->module_count >= PROJECT_STORE_MAX_MODULES) {
            return false;
        }
        index = header->module_count++;
        memset(&header->modules[index], 0, sizeof(header->modules[index]));
        strncpy(header->modules[index].name, name, PROJECT_STORE_NAME_MAX - 1);
    }

    uint32_t offset = 0;
    if (!project_store_append_blob(&offset, data, len)) {
        project_store_reload_shadow();   // undo the removal above; flash is untouched
        return false;
    }

    header->modules[index].offset = offset;
    header->modules[index].length = (uint32_t)len;
    return project_store_commit_shadow();
}
