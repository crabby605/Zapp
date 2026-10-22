#pragma once

#include <stdbool.h>

void usb_msc_init_disk(void);

// Returns true if a sync was performed (source changed on drive).
// Call from the main loop — uses a 1-second debounce after the last
// USB write, then flushes the in-RAM disk to flash storage.
bool usb_msc_check_and_sync(void);
