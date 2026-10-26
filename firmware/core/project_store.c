#include "project_store.h"

#include <string.h>

#include "port.h"

#define PROJECT_STORE_MAGIC 0x5A505246u
#define PROJECT_STORE_VERSION 6u   // 6: sized per board, 32 files, 32-char names, no per-file cap
// Fixed layout inside the data area: main source, then bytecode, then modules.
// Fixed (not packed) so re-saving a main.zap of a different length can't move
// the bytecode out from under a previously stored offset.
#define PROJECT_STORE_BC_OFFSET PROJECT_STORE_MAIN_MAX
#define PROJECT_STORE_MODULE_OFFSET (PROJECT_STORE_MAIN_MAX + PROJECT_STORE_BC_MAX)

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
    uint32_t region_size;                 // the store's size when written; another size means another layout
    char board[PROJECT_STORE_NAME_MAX];   // which board this is, set by the host ("" = not told yet)
    ProjectStoreModuleEntry modules[PROJECT_STORE_MAX_MODULES];
    uint8_t data[];
} ProjectStoreHeader;

static uint8_t *project_store_shadow;   // RAM copy of the whole region (port_alloc_big)
static size_t project_store_size;

// First use: find out how much this board gives the store.
static bool project_store_open(void) {
    if (project_store_shadow) return true;
    project_store_size = port_store_size();
    project_store_shadow = port_alloc_big(project_store_size);
    return project_store_shadow != NULL;
}
static bool project_store_loaded = false;

static const uint8_t *project_store_flash_base(void) {
    return port_store_flash();
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
    return project_store_size - project_store_header_size();
}

static void project_store_reload_shadow(void) {
    memcpy(project_store_shadow, project_store_flash_base(), project_store_size);
    project_store_loaded = true;
}

static bool project_store_is_valid(const ProjectStoreHeader *header) {
    return header->magic == PROJECT_STORE_MAGIC &&
           header->version == PROJECT_STORE_VERSION &&
           header->module_count <= PROJECT_STORE_MAX_MODULES &&
           header->main_len <= PROJECT_STORE_MAIN_MAX &&
           header->bc_len <= PROJECT_STORE_BC_MAX &&
           header->region_size == project_store_size &&
           PROJECT_STORE_MODULE_OFFSET <= project_store_data_capacity();
}

// Per-sector flash writes (USB-safe)
// One 4KB sector at a time with an idle callback between each, so a save
// never blacks out USB long enough for the host to drop the drive. Unchanged
// sectors are skipped entirely.

static project_store_idle_fn idle_cb = NULL;

void project_store_set_idle_callback(project_store_idle_fn cb) {
    idle_cb = cb;
}

static bool project_store_commit_shadow(void) {
    const uint8_t *flash = project_store_flash_base();

    for (size_t offset = 0; offset < project_store_size; offset += PORT_STORE_SECTOR) {
        if (memcmp(project_store_shadow + offset, flash + offset, PORT_STORE_SECTOR) == 0) {
            continue;
        }
        if (!port_store_write_sector(offset, project_store_shadow + offset)) {
            return false;
        }
        if (idle_cb) idle_cb();
    }

    return true;
}

static bool project_store_ensure_loaded(void) {
    if (!project_store_open()) return false;
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

// Where packed file data currently ends.
static size_t project_store_data_end(void) {
    const ProjectStoreHeader *header = project_store_header_const();
    size_t end = PROJECT_STORE_MODULE_OFFSET;
    for (size_t i = 0; i < header->module_count; i++) {
        size_t e = header->modules[i].offset + header->modules[i].length;
        if (e > end) end = e;
    }
    return end;
}

size_t project_store_files_capacity(void) {
    return project_store_data_capacity() - PROJECT_STORE_MODULE_OFFSET;
}

void project_store_init(void) {
    if (!project_store_open()) return;
    project_store_reload_shadow();
    (void)project_store_ensure_loaded();
}

bool project_store_format(void) {
    if (!project_store_open()) return false;
    memset(project_store_shadow, 0xFF, project_store_size);
    ProjectStoreHeader *header = project_store_header();
    memset(header, 0, project_store_header_size());
    header->magic = PROJECT_STORE_MAGIC;
    header->version = PROJECT_STORE_VERSION;
    header->main_len = 0;
    header->bc_len = 0;
    header->module_count = 0;
    header->region_size = (uint32_t)project_store_size;
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

const uint8_t *project_store_module_data(const char *name, size_t *len) {
    if (!name || !project_store_ensure_loaded()) return NULL;
    size_t index = project_store_find_module(name);
    if (index >= PROJECT_STORE_MAX_MODULES) return NULL;
    const ProjectStoreModuleEntry *entry = &project_store_header_const()->modules[index];
    if (len) *len = entry->length;
    return project_store_data_base_const() + entry->offset;
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

bool project_store_write_module_from(const char *name, size_t len, project_store_reader read, void *ctx) {
    if (!name || !read || strlen(name) >= PROJECT_STORE_NAME_MAX) {
        return false;
    }
    if (!project_store_ensure_loaded()) {
        return false;
    }

    ProjectStoreHeader *header = project_store_header();
    size_t index = project_store_find_module(name);

    // Same bytes as stored? Then there's nothing to write.
    if (index < PROJECT_STORE_MAX_MODULES && header->modules[index].length == len) {
        const uint8_t *old = project_store_data_base_const() + header->modules[index].offset;
        uint8_t chunk[256];
        bool same = true;
        for (size_t done = 0; done < len && same; done += sizeof(chunk)) {
            size_t n = len - done < sizeof(chunk) ? len - done : sizeof(chunk);
            if (!read(ctx, done, chunk, n)) return false;
            same = memcmp(chunk, old + done, n) == 0;
        }
        if (same) return true;
    }

    if (index < PROJECT_STORE_MAX_MODULES) {
        project_store_remove_module(index);
    }
    size_t at = project_store_data_end();
    if (header->module_count >= PROJECT_STORE_MAX_MODULES || at + len > project_store_data_capacity()) {
        project_store_reload_shadow();   // undo the removal; flash is untouched
        return false;
    }
    if (len && !read(ctx, 0, project_store_data_base() + at, len)) {
        project_store_reload_shadow();
        return false;
    }

    index = header->module_count++;
    memset(&header->modules[index], 0, sizeof(header->modules[index]));
    strncpy(header->modules[index].name, name, PROJECT_STORE_NAME_MAX - 1);
    header->modules[index].offset = (uint32_t)at;
    header->modules[index].length = (uint32_t)len;
    return project_store_commit_shadow();
}
