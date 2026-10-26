// Runs firmware/core/project_store.c on the host against a fake flash, to check
// the parts that could lose files: packing, replacing, running out of room,
// and a copy that fails halfway. Built and run by tests/store.test.ts.
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "port.h"
#include "project_store.h"

// STORE_KB: 32 like a board without PSRAM, 512 like one with it.
#ifndef STORE_KB
#define STORE_KB 32
#endif
static uint8_t flash[STORE_KB * 1024];
static int sector_writes;

size_t port_store_size(void) { return sizeof(flash); }
size_t port_disk_blocks(void) { return 96; }
void *port_alloc_big(size_t bytes) { return malloc(bytes); }
const uint8_t *port_store_flash(void) { return flash; }
bool port_store_write_sector(size_t offset, const uint8_t *src) {
    memcpy(flash + offset, src, PORT_STORE_SECTOR);
    sector_writes++;
    return true;
}

typedef struct { const uint8_t *data; bool fail_after_half; } Src;

static bool read_src(void *ctx, size_t offset, uint8_t *out, size_t n) {
    const Src *s = ctx;
    if (s->fail_after_half && offset + n > 100) return false;
    memcpy(out, s->data + offset, n);
    return true;
}

static bool put(const char *name, const uint8_t *data, size_t len) {
    Src s = { data, false };
    return project_store_write_module_from(name, len, read_src, &s);
}

static bool holds(const char *name, const uint8_t *data, size_t len) {
    size_t got = 0;
    const uint8_t *p = project_store_module_data(name, &got);
    return p && got == len && memcmp(p, data, len) == 0;
}

int main(void) {
    static uint8_t big[16 * 1024], small[300], other[700];
    for (size_t i = 0; i < sizeof(big); i++) big[i] = (uint8_t)(i * 7);
    memset(small, 'a', sizeof(small));
    memset(other, 'b', sizeof(other));

    memset(flash, 0xFF, sizeof(flash));
    project_store_init();   // blank flash → formats
    size_t room = project_store_files_capacity();
    assert(room > sizeof(big) + sizeof(small) + sizeof(other));

    // No per-file cap: a 16KB page fits, beside others.
    assert(put("web/index.html", big, sizeof(big)));
    assert(put("bmp280.zappmod", small, sizeof(small)));
    assert(put("web/style.css", other, sizeof(other)));
    assert(holds("web/index.html", big, sizeof(big)));

    // Replacing a file with a different size keeps the others intact.
    assert(put("bmp280.zappmod", other, sizeof(other)));
    assert(holds("web/index.html", big, sizeof(big)));
    assert(holds("web/style.css", other, sizeof(other)));
    assert(holds("bmp280.zappmod", other, sizeof(other)));

    // Saving the same bytes again writes nothing to flash.
    int before = sector_writes;
    assert(put("web/index.html", big, sizeof(big)));
    assert(sector_writes == before);

    // Too big for what's left: refused, nothing else touched.
    static uint8_t huge[STORE_KB * 1024];
    assert(!put("web/huge.html", huge, room));
    assert(holds("web/index.html", big, sizeof(big)));
    assert(!project_store_module_data("web/huge.html", NULL));

    // A copy that fails halfway leaves the old file as it was.
    Src broken = { small, true };
    assert(!project_store_write_module_from("web/style.css", sizeof(small), read_src, &broken));
    assert(holds("web/style.css", other, sizeof(other)));

    // It all comes back after a power cycle.
    project_store_init();
    assert(holds("web/index.html", big, sizeof(big)));
    assert(holds("bmp280.zappmod", other, sizeof(other)));

    // Up to PROJECT_STORE_MAX_MODULES files, then refused.
    assert(project_store_delete_module("web/index.html"));
    char name[PROJECT_STORE_NAME_MAX];
    while (project_store_module_count() < PROJECT_STORE_MAX_MODULES) {
        snprintf(name, sizeof(name), "f%zu.zappmod", project_store_module_count());
        assert(put(name, small, 10));
    }
    assert(!put("one_too_many.zappmod", small, 10));

    // A 31-character name fits; 32 doesn't.
    assert(project_store_delete_module("f2.zappmod"));
    assert(strlen("web/abcdefghijklmnopqrstuv.html") == 31);
    assert(put("web/abcdefghijklmnopqrstuv.html", small, 10));
    assert(project_store_delete_module("web/abcdefghijklmnopqrstuv.html"));
    assert(!put("web/abcdefghijklmnopqrstuvw.html", small, 10));   // 32

    printf("store ok: %zu bytes for files\n", room);
    return 0;
}
