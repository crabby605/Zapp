#include "usb_msc.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>

#include "config.h"
#include "pico/stdlib.h"
#include "project_store.h"
#include "tusb.h"

// Disk geometry
#define DISK_BLOCK_SIZE 512
#define DISK_BLOCK_NUM 64
#define BOOT_SECTOR 0
#define FAT_SECTOR 1
#define ROOT_DIR_START 2
#define DATA_START 4

// Cluster layout
// One sector per cluster; data clusters run 2..61. Fixed clusters first, then
// main.zap and module files are packed after them, each taking only the
// clusters its size needs — so the FAT never holds orphaned chains and the
// host gets the rest as free space for its own save-via-temp-file dance.
#define BOOT_TXT_CLUSTER 2
#define MODULE_DIR_CLUSTER 3      // 2 clusters (3-4): 32 entries, enough for
#define MODULE_DIR_CLUSTERS 2     // 8 modules with long names + "." and ".."
#define FSEVENTSD_CLUSTER 5
#define WEB_DIR_CLUSTER 6         // 1 cluster: 16 entries, ~7 web files
#define FIRST_FILE_CLUSTER 7
#define LAST_CLUSTER (DISK_BLOCK_NUM - DATA_START + 1)
#define MAX_DISK_MODULES PROJECT_STORE_MAX_MODULES
#define ROOT_DIR_ENTRIES 32

// Auto-sync (CircuitPython-style write detection)
// After the host OS finishes writing, we wait this long before syncing to
// flash.  Prevents partial-write corruption when the OS flushes in stages.
#define SYNC_DEBOUNCE_US 1000000  // 1 second

static uint8_t disk[DISK_BLOCK_NUM][DISK_BLOCK_SIZE];
static bool ejected = false;
static bool dirty = false;
static uint64_t last_write_us = 0;

static uint16_t fat_entries[DISK_BLOCK_NUM] = {0};

// Helpers

static void write_le16(uint8_t *p, uint16_t v) {
    p[0] = (uint8_t)(v & 0xFF);
    p[1] = (uint8_t)((v >> 8) & 0xFF);
}

static void write_le32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)(v & 0xFF);
    p[1] = (uint8_t)((v >> 8) & 0xFF);
    p[2] = (uint8_t)((v >> 16) & 0xFF);
    p[3] = (uint8_t)((v >> 24) & 0xFF);
}

static void fat_set(uint16_t cluster, uint16_t value) {
    fat_entries[cluster] = value;
}

static void fat_flush_to_sector(void) {
    uint8_t *fat = disk[FAT_SECTOR];
    memset(fat, 0, DISK_BLOCK_SIZE);
    fat[0] = 0xF8;
    fat[1] = 0xFF;
    fat[2] = 0xFF;

    for (uint16_t cluster = 2; cluster < DISK_BLOCK_NUM; cluster += 2) {
        uint16_t a = fat_entries[cluster];
        uint16_t b = fat_entries[cluster + 1];
        uint32_t idx = 3 + ((cluster - 2) / 2) * 3;
        if (idx + 2 >= DISK_BLOCK_SIZE) break;
        fat[idx + 0] = (uint8_t)(a & 0xFF);
        fat[idx + 1] = (uint8_t)(((a >> 8) & 0x0F) | ((b & 0x0F) << 4));
        fat[idx + 2] = (uint8_t)((b >> 4) & 0xFF);
    }
}

static void set_dir_entry(uint8_t *entry, const char *name83, uint8_t attr,
                          uint16_t cluster, uint32_t size) {
    memset(entry, 0, 32);
    memcpy(entry, name83, 11);
    entry[11] = attr;
    write_le16(entry + 26, cluster);
    write_le32(entry + 28, size);
}

// VFAT Long File Name (LFN) helpers
// macOS needs real LFN entries for dot-files like .metadata_never_index and
// .fseventsd — 8.3 names can't represent them and macOS won't recognise the
// short-name aliases.

static uint8_t lfn_checksum(const char name83[11]) {
    uint8_t sum = 0;
    for (int i = 0; i < 11; i++)
        sum = (uint8_t)(((sum & 1) << 7) + (sum >> 1) + (uint8_t)name83[i]);
    return sum;
}

// Write one 32-byte LFN directory slot.
// `part_start` = first char index this slot covers (each slot holds 13 chars).
static void write_lfn_slot(uint8_t *entry, uint8_t seq_byte,
                           const char *long_name, size_t name_len,
                           int part_start, uint8_t checksum) {
    memset(entry, 0xFF, 32);
    entry[0]    = seq_byte;
    entry[0x0B] = 0x0F;    // ATTR_LONG_NAME
    entry[0x0C] = 0x00;
    entry[0x0D] = checksum;
    entry[0x1A] = 0x00;
    entry[0x1B] = 0x00;

    // 13 UCS-2LE chars are scattered across the entry at these byte offsets:
    static const uint8_t off[13] = {
        0x01,0x03,0x05,0x07,0x09,           // chars 1-5
        0x0E,0x10,0x12,0x14,0x16,0x18,      // chars 6-11
        0x1C,0x1E                            // chars 12-13
    };
    bool past_end = false;
    for (int i = 0; i < 13; i++) {
        int ci = part_start + i;
        uint16_t ch;
        if (past_end)            ch = 0xFFFF;
        else if ((size_t)ci >= name_len) { ch = 0x0000; past_end = true; }
        else                     ch = (uint16_t)(unsigned char)long_name[ci];
        entry[off[i]]     = ch & 0xFF;
        entry[off[i] + 1] = (ch >> 8) & 0xFF;
    }
}

// Write a complete LFN + 8.3 directory entry set starting at `dir`.
// Returns the number of 32-byte entries consumed.
static int write_lfn_dir_entry(uint8_t *dir, const char *long_name,
                               const char short_83[11], uint8_t attr,
                               uint16_t cluster, uint32_t size) {
    size_t name_len = strlen(long_name);
    int num_lfn = (int)((name_len + 12) / 13);
    uint8_t cksum = lfn_checksum(short_83);

    // LFN slots go in reverse order (highest first)
    for (int i = num_lfn; i >= 1; i--) {
        uint8_t seq = (uint8_t)i;
        if (i == num_lfn) seq |= 0x40;       // mark last LFN entry
        write_lfn_slot(dir + (num_lfn - i) * 32, seq,
                       long_name, name_len, (i - 1) * 13, cksum);
    }

    // 8.3 entry immediately after the LFN chain
    set_dir_entry(dir + num_lfn * 32, short_83, attr, cluster, size);
    return num_lfn + 1;
}

static void format_name_83(const char *src, char out[11]) {
    memset(out, ' ', 11);
    const char *dot = strrchr(src, '.');
    size_t base_len = dot ? (size_t)(dot - src) : strlen(src);
    size_t ext_len  = dot ? strlen(dot + 1) : 0;
    if (base_len > 8) base_len = 8;
    if (ext_len  > 3) ext_len  = 3;
    for (size_t i = 0; i < base_len; i++)
        out[i] = (char)toupper((unsigned char)src[i]);
    for (size_t i = 0; i < ext_len; i++)
        out[8 + i] = (char)toupper((unsigned char)dot[1 + i]);
}

// Boot sector

static void build_boot_sector(void) {
    uint8_t *b = disk[BOOT_SECTOR];
    memset(b, 0, DISK_BLOCK_SIZE);
    b[0] = 0xEB; b[1] = 0x3C; b[2] = 0x90;
    memcpy(&b[3], "MSDOS5.0", 8);
    write_le16(&b[11], DISK_BLOCK_SIZE);
    b[13] = 1;                           // sectors per cluster
    write_le16(&b[14], 1);               // reserved sectors
    b[16] = 1;                           // number of FATs
    write_le16(&b[17], 32);              // root dir entries
    write_le16(&b[19], DISK_BLOCK_NUM);  // total sectors
    b[21] = 0xF8;                        // media descriptor
    write_le16(&b[22], 1);               // sectors per FAT
    write_le16(&b[24], 1);               // sectors per track
    write_le16(&b[26], 1);               // heads
    b[36] = 0x80;
    b[38] = 0x29;                        // extended boot sig
    write_le32(&b[39], 0x12345678);      // volume serial
    memcpy(&b[43], "Zapp Drive ", 11);   // volume label
    memcpy(&b[54], "FAT12   ", 8);       // filesystem type
    b[510] = 0x55;
    b[511] = 0xAA;
}

// Cluster I/O

static uint8_t *cluster_sector(uint16_t cluster) {
    return disk[DATA_START + (cluster - 2)];
}

// Next cluster handed out by alloc_file() while building the disk.
static uint16_t next_free_cluster = FIRST_FILE_CLUSTER;

// Give `len` bytes a contiguous chain of just-enough clusters and copy the
// data in. Returns the first cluster, or 0 for an empty file (FAT convention).
static uint16_t alloc_file(const uint8_t *data, size_t len) {
    uint16_t count = (uint16_t)((len + DISK_BLOCK_SIZE - 1) / DISK_BLOCK_SIZE);
    if (count == 0 || next_free_cluster + count - 1 > LAST_CLUSTER) return 0;
    uint16_t first = next_free_cluster;
    for (uint16_t i = 0; i < count; i++) {
        uint16_t c = first + i;
        fat_set(c, (i + 1 < count) ? (uint16_t)(c + 1) : 0x0FFF);
        size_t chunk = len - (size_t)i * DISK_BLOCK_SIZE;
        if (chunk > DISK_BLOCK_SIZE) chunk = DISK_BLOCK_SIZE;
        memset(cluster_sector(c), 0, DISK_BLOCK_SIZE);
        memcpy(cluster_sector(c), data + (size_t)i * DISK_BLOCK_SIZE, chunk);
    }
    next_free_cluster += count;
    return first;
}

// Reload FAT12 entries from disk sector
// The host OS may have rewritten the FAT sector.  Re-parse it into our
// fat_entries[] array before walking any chains, so we follow the host's
// view of the allocation — not the stale init-time view.

static void fat_reload_from_sector(void) {
    const uint8_t *fat = disk[FAT_SECTOR];
    memset(fat_entries, 0, sizeof(fat_entries));

    for (uint16_t cluster = 2; cluster < DISK_BLOCK_NUM; cluster += 2) {
        uint32_t idx = 3 + ((cluster - 2) / 2) * 3;
        if (idx + 2 >= DISK_BLOCK_SIZE) break;
        fat_entries[cluster]     = fat[idx] | ((uint16_t)(fat[idx + 1] & 0x0F) << 8);
        fat_entries[cluster + 1] = (fat[idx + 1] >> 4) | ((uint16_t)fat[idx + 2] << 4);
    }
}

// Follow a file's FAT chain, copying up to `size` bytes. Returns false if the
// chain is broken, loops, or is shorter than the size the directory claims.
static bool read_chain(uint16_t cluster, uint32_t size, uint8_t *out, size_t max) {
    if (size > max) return false;
    size_t copied = 0;
    for (int hops = 0; copied < size; hops++) {
        if (cluster < 2 || cluster > LAST_CLUSTER || hops > LAST_CLUSTER) return false;
        size_t chunk = size - copied;
        if (chunk > DISK_BLOCK_SIZE) chunk = DISK_BLOCK_SIZE;
        memcpy(out + copied, cluster_sector(cluster), chunk);
        copied += chunk;
        cluster = fat_entries[cluster];
    }
    return true;
}

static uint32_t entry_size(const uint8_t *e) {
    return e[28] | (e[29] << 8) | ((uint32_t)e[30] << 16) | ((uint32_t)e[31] << 24);
}

static uint16_t entry_cluster(const uint8_t *e) {
    return (uint16_t)(e[26] | (e[27] << 8));
}

// Walk directory entries, rebuilding long (VFAT) names. Calls `fn` for each
// visible regular file with its long name if it has one, else its 8.3 name.
typedef void (*dir_file_fn)(const char *name, const uint8_t *entry);

static void walk_dir(const uint8_t *dir, size_t entries, dir_file_fn fn) {
    char lfn[PROJECT_STORE_NAME_MAX];
    bool lfn_ok = false;
    uint8_t lfn_sum = 0;

    for (size_t i = 0; i < entries; i++) {
        const uint8_t *e = dir + i * 32;
        if (e[0] == 0x00) break;
        if (e[0] == 0xE5) { lfn_ok = false; continue; }

        if (e[11] == 0x0F) {   // LFN slot: 13 UCS-2 chars at scattered offsets
            static const uint8_t off[13] = { 1,3,5,7,9, 14,16,18,20,22,24, 28,30 };
            uint8_t seq = e[0] & 0x1F;
            if (e[0] & 0x40) {   // last slot comes first: (re)start the name
                memset(lfn, 0, sizeof(lfn));
                lfn_ok = true;
                lfn_sum = e[13];
            }
            if (!lfn_ok || seq == 0 || e[13] != lfn_sum) { lfn_ok = false; continue; }
            for (int k = 0; k < 13; k++) {
                size_t pos = (size_t)(seq - 1) * 13 + (size_t)k;
                uint16_t ch = (uint16_t)(e[off[k]] | (e[off[k] + 1] << 8));
                if (ch == 0x0000 || ch == 0xFFFF) break;
                if (pos >= sizeof(lfn) - 1 || ch > 0x7E) { lfn_ok = false; break; }
                lfn[pos] = (char)ch;
            }
            continue;
        }

        bool use_lfn = lfn_ok && lfn_sum == lfn_checksum((const char *)e);
        lfn_ok = false;
        if (e[11] & (0x08 | 0x10 | 0x02)) continue;   // volume, dir, hidden

        char name[PROJECT_STORE_NAME_MAX];
        if (use_lfn) {
            memcpy(name, lfn, sizeof(name));
        } else {
            size_t pos = 0;
            for (size_t j = 0; j < 8 && e[j] != ' '; j++) name[pos++] = (char)tolower(e[j]);
            if (e[8] != ' ') name[pos++] = '.';
            for (size_t j = 8; j < 11 && e[j] != ' '; j++) name[pos++] = (char)tolower(e[j]);
            name[pos] = '\0';
        }
        if (name[0] == '.' || name[0] == '\0') continue;   // macOS "._x" AppleDouble etc.
        fn(name, e);
    }
}

// Sync disk → flash

static bool main_changed;
static bool sync_ok;
// Web files share the module store, named "web/<file>".
#define WEB_PREFIX "web/"
#define WEB_PREFIX_LEN 4

static char seen_modules[2 * MAX_DISK_MODULES][PROJECT_STORE_NAME_MAX];
static size_t seen_count;

static void sync_main_file(const char *name, const uint8_t *e) {
    if (strcmp(name, "main.zap") != 0) return;
    static char buf[PROJECT_STORE_MAIN_MAX];
    uint32_t size = entry_size(e);
    if (!read_chain(entry_cluster(e), size, (uint8_t *)buf, sizeof(buf))) return;
    if (project_store_main_equals(buf, size)) return;
    if (project_store_write_main(buf, size)) main_changed = true;
    else sync_ok = false;
}

static void sync_module_file(const char *name, const uint8_t *e) {
    if (seen_count >= 2 * MAX_DISK_MODULES) return;
    static uint8_t buf[PROJECT_STORE_MODULE_MAX];
    // Mark it seen even if unreadable (e.g. mid-write), so it isn't deleted.
    strncpy(seen_modules[seen_count++], name, PROJECT_STORE_NAME_MAX - 1);
    uint32_t size = entry_size(e);
    if (!read_chain(entry_cluster(e), size, buf, sizeof(buf))) return;
    if (!project_store_write_module(name, buf, size)) sync_ok = false;
}

static void sync_web_file(const char *name, const uint8_t *e) {
    char stored[PROJECT_STORE_NAME_MAX];
    if (strlen(name) >= sizeof(stored) - WEB_PREFIX_LEN) return;
    snprintf(stored, sizeof(stored), WEB_PREFIX "%s", name);
    sync_module_file(stored, e);
}

static void project_store_sync_from_disk(void) {
    // Snapshot the write timestamp so we can detect new writes that arrive
    // during the (potentially slow) flash commit.
    uint64_t sync_stamp = last_write_us;

    // Re-parse FAT from the disk sector the host actually wrote.
    fat_reload_from_sector();
    main_changed = false;
    sync_ok = true;
    seen_count = 0;
    memset(seen_modules, 0, sizeof(seen_modules));

    walk_dir(disk[ROOT_DIR_START], ROOT_DIR_ENTRIES, sync_main_file);

    // modules/ is our fixed 2-cluster directory; the host fills it in place.
    walk_dir(cluster_sector(MODULE_DIR_CLUSTER),
             MODULE_DIR_CLUSTERS * DISK_BLOCK_SIZE / 32, sync_module_file);
    walk_dir(cluster_sector(WEB_DIR_CLUSTER), DISK_BLOCK_SIZE / 32, sync_web_file);

    // A module deleted from the drive goes from flash too, or it'd come back
    // on the next boot. Walk backwards: deleting shifts later entries down.
    for (size_t i = project_store_module_count(); i-- > 0;) {
        const char *stored = project_store_module_name(i);
        bool seen = false;
        for (size_t j = 0; j < seen_count && !seen; j++)
            seen = stored && strcmp(stored, seen_modules[j]) == 0;
        if (stored && !seen && !project_store_delete_module(stored)) sync_ok = false;
    }

    // Only clear dirty if the write succeeded AND no new writes arrived
    // during the commit (the host may have written while we were flashing).
    if (sync_ok && last_write_us == sync_stamp) {
        dirty = false;
        last_write_us = 0;
    }
}

// 8.3 alias for a module's long name: "bmp280.zappmod" -> "BMP280~1ZAP".
// The ~N suffix is the slot number, so aliases never collide.
static void module_alias_83(const char *name, size_t slot, char out[11]) {
    memset(out, ' ', 11);
    const char *dot = strrchr(name, '.');
    size_t base_len = dot ? (size_t)(dot - name) : strlen(name);
    if (base_len > 6) base_len = 6;
    for (size_t i = 0; i < base_len; i++) {
        char c = (char)toupper((unsigned char)name[i]);
        out[i] = isalnum((unsigned char)c) ? c : '_';
    }
    out[base_len] = '~';
    out[base_len + 1] = (char)('1' + slot);
    for (size_t i = 0; dot && i < 3 && dot[1 + i]; i++) {
        char c = (char)toupper((unsigned char)dot[1 + i]);
        out[8 + i] = isalnum((unsigned char)c) ? c : '_';
    }
}

// Public API

void usb_msc_init_disk(void) {
    memset(disk, 0, sizeof(disk));
    memset(fat_entries, 0, sizeof(fat_entries));
    ejected = false;
    dirty = false;
    last_write_us = 0;
    next_free_cluster = FIRST_FILE_CLUSTER;

    build_boot_sector();

    // Fixed clusters
    fat_set(BOOT_TXT_CLUSTER, 0x0FFF);
    fat_set(MODULE_DIR_CLUSTER, MODULE_DIR_CLUSTER + 1);
    fat_set(MODULE_DIR_CLUSTER + 1, 0x0FFF);
    fat_set(FSEVENTSD_CLUSTER, 0x0FFF);
    fat_set(WEB_DIR_CLUSTER, 0x0FFF);

    // Root directory
    uint8_t *root = disk[ROOT_DIR_START];

    // Entry 0: volume label
    set_dir_entry(root + 0, "Zapp Drive ", 0x08, 0, 0);

    // Entry 1: main.zap
    char main83[11];
    format_name_83("main.zap", main83);
    size_t main_len = 0;
    static char main_buf[PROJECT_STORE_MAIN_MAX + 1];
    project_store_read_main(main_buf, sizeof(main_buf), &main_len);
    uint16_t main_cluster = alloc_file((const uint8_t *)main_buf, main_len);
    set_dir_entry(root + 32, main83, 0x20, main_cluster,
                  main_cluster ? (uint32_t)main_len : 0);
    root[32 + 12] = 0x18;   // NT case bits: show as "main.zap", not "MAIN.ZAP"

    // Entry 2: boot_out.txt (read-only, like CircuitPython)
    char boot_txt[DISK_BLOCK_SIZE];
    int boot_txt_len = snprintf(boot_txt, sizeof(boot_txt),
        "Zapp v" ZAPP_VERSION "\r\n"
        "Board: " ZAPP_CHIP " (" ZAPP_VARIANT ")\r\n"
        "Flash: %dKB  RAM: %dKB\r\n"
        "\r\n"
        "Edit main.zap here; it is saved to the board automatically.\r\n"
        "To run your edits, open main.zap in the Zapp IDE and press Flash\r\n"
        "(the board can't compile .zap source on its own yet).\r\n",
        ZAPP_FLASH_KB, ZAPP_RAM_KB);
    char boot83[11];
    format_name_83("boot_out.txt", boot83);
    set_dir_entry(root + 64, boot83, 0x01, BOOT_TXT_CLUSTER,
                  (uint32_t)boot_txt_len);
    root[64 + 12] = 0x18;
    memcpy(cluster_sector(BOOT_TXT_CLUSTER), boot_txt, (size_t)boot_txt_len);

    // Entry 3: modules/ directory
    set_dir_entry(root + 96, "MODULES    ", 0x10, MODULE_DIR_CLUSTER, 0);
    root[96 + 12] = 0x08;

    // Entries 4-8: macOS metadata suppression (LFN entries + 8.3)
    // Prevents Spotlight indexing and FSEvents logging on the drive,
    // which reduces unwanted writes and auto-sync triggers.
    int eidx = 4;  // next free root dir slot (in 32-byte units)

    eidx += write_lfn_dir_entry(root + eidx * 32,
                ".metadata_never_index", "METADA~1   ",
                0x27,  // read-only | hidden | system | archive
                0, 0); // zero-length marker file

    eidx += write_lfn_dir_entry(root + eidx * 32,
                ".fseventsd", "FSEVEN~1   ",
                0x12,  // hidden | directory
                FSEVENTSD_CLUSTER, 0);

    set_dir_entry(root + eidx * 32, "WEB        ", 0x10, WEB_DIR_CLUSTER, 0);
    root[eidx * 32 + 12] = 0x08;   // show as "web"
    eidx++;

    // .fseventsd directory content
    uint8_t *fsev_dir = cluster_sector(FSEVENTSD_CLUSTER);
    set_dir_entry(fsev_dir + 0,  ".          ", 0x10, FSEVENTSD_CLUSTER, 0);
    set_dir_entry(fsev_dir + 32, "..         ", 0x10, 0, 0);
    set_dir_entry(fsev_dir + 64, "NO_LOG     ", 0x22, 0, 0); // hidden marker

    // Modules directory content
    // Long names (".zappmod" doesn't fit 8.3) so files keep their real names.
    uint8_t *modules_dir = cluster_sector(MODULE_DIR_CLUSTER);   // spans 2 sectors
    set_dir_entry(modules_dir + 0,  ".          ", 0x10, MODULE_DIR_CLUSTER, 0);
    set_dir_entry(modules_dir + 32, "..         ", 0x10, 0, 0);
    int midx = 2;
    const int mdir_slots = MODULE_DIR_CLUSTERS * DISK_BLOCK_SIZE / 32;

    uint8_t *web_dir = cluster_sector(WEB_DIR_CLUSTER);
    set_dir_entry(web_dir + 0,  ".          ", 0x10, WEB_DIR_CLUSTER, 0);
    set_dir_entry(web_dir + 32, "..         ", 0x10, 0, 0);
    int widx = 2;
    const int wdir_slots = DISK_BLOCK_SIZE / 32;

    size_t module_count = project_store_module_count();
    for (size_t i = 0; i < module_count && i < MAX_DISK_MODULES; i++) {
        const char *module_name = project_store_module_name(i);
        if (!module_name) continue;
        size_t len = 0;
        static uint8_t buf[PROJECT_STORE_MODULE_MAX];
        if (!project_store_read_module(module_name, buf, sizeof(buf), &len))
            continue;
        bool web = strncmp(module_name, WEB_PREFIX, WEB_PREFIX_LEN) == 0;
        const char *shown = web ? module_name + WEB_PREFIX_LEN : module_name;
        uint8_t *dir = web ? web_dir : modules_dir;
        int *idx = web ? &widx : &midx;
        int needed = (int)((strlen(shown) + 12) / 13) + 1;
        if (*idx + needed > (web ? wdir_slots : mdir_slots)) continue;

        uint16_t cluster = alloc_file(buf, len);
        char alias[11];
        module_alias_83(shown, i, alias);
        *idx += write_lfn_dir_entry(dir + *idx * 32, shown, alias,
                                    0x20, cluster, cluster ? (uint32_t)len : 0);
    }
    fat_flush_to_sector();
}

bool usb_msc_check_and_sync(void) {
    if (!dirty || last_write_us == 0) return false;
    uint64_t now = time_us_64();
    if (now - last_write_us < SYNC_DEBOUNCE_US) return false;

    project_store_sync_from_disk();
    return main_changed;  // caller tells the user main.zap changed
}

// TinyUSB MSC callbacks

void tud_msc_inquiry_cb(uint8_t lun, uint8_t vendor_id[8],
                        uint8_t product_id[16], uint8_t product_rev[4]) {
    (void) lun;
    memcpy(vendor_id,   "Zapp    ", 8);
    memcpy(product_id,  "Zapp Core       ", 16);
    memcpy(product_rev, "1.0 ", 4);
}

bool tud_msc_test_unit_ready_cb(uint8_t lun) {
    (void) lun;
    if (ejected) {
        tud_msc_set_sense(lun, SCSI_SENSE_NOT_READY, 0x3a, 0x00);
        return false;
    }
    return true;
}

void tud_msc_capacity_cb(uint8_t lun, uint32_t *block_count,
                         uint16_t *block_size) {
    (void) lun;
    *block_count = DISK_BLOCK_NUM;
    *block_size  = DISK_BLOCK_SIZE;
}

bool tud_msc_start_stop_cb(uint8_t lun, uint8_t power_condition,
                           bool start, bool load_eject) {
    (void) lun;
    (void) power_condition;
    if (load_eject) {
        if (!start) {
            // Eject — final sync, same as CircuitPython unmount. Don't flash
            // here: this runs inside tud_task(), and the flash commit pumps
            // tud_task() again. Expire the debounce so the main loop syncs now.
            if (dirty) last_write_us = 1;
            ejected = true;
        } else {
            // Re-insert (host re-starting the unit)
            ejected = false;
        }
    }
    return true;
}

// Called by TinyUSB when the host (re)mounts the device.
// Clears the ejected flag so the drive is accessible after a USB
// bus reset or reconnection.
void tud_mount_cb(void) {
    ejected = false;
}

int32_t tud_msc_read10_cb(uint8_t lun, uint32_t lba, uint32_t offset,
                          void *buffer, uint32_t bufsize) {
    (void) lun;
    if (lba >= DISK_BLOCK_NUM) return -1;
    if (offset + bufsize > DISK_BLOCK_SIZE) return -1;
    memcpy(buffer, disk[lba] + offset, bufsize);
    return (int32_t)bufsize;
}

bool tud_msc_is_writable_cb(uint8_t lun) {
    (void) lun;
    return true;
}

int32_t tud_msc_write10_cb(uint8_t lun, uint32_t lba, uint32_t offset,
                           uint8_t *buffer, uint32_t bufsize) {
    (void) lun;
    if (lba >= DISK_BLOCK_NUM) return -1;
    if (offset + bufsize > DISK_BLOCK_SIZE) return -1;
    memcpy(disk[lba] + offset, buffer, bufsize);
    dirty = true;
    last_write_us = time_us_64();
    return (int32_t)bufsize;
}

int32_t tud_msc_scsi_cb(uint8_t lun, uint8_t const scsi_cmd[16],
                        void *buffer, uint16_t bufsize) {
    (void) buffer;
    (void) bufsize;
    tud_msc_set_sense(lun, SCSI_SENSE_ILLEGAL_REQUEST, 0x20, 0x00);
    return -1;
}
