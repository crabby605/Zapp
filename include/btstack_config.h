#ifndef BTSTACK_CONFIG_H
#define BTSTACK_CONFIG_H

// BLE peripheral only — no classic Bluetooth, no central role, no pairing.
// That is what a Nordic-UART peripheral needs and nothing more.
// (pico_btstack_ble already defines ENABLE_BLE on the command line.)

#ifndef ENABLE_BLE
#define ENABLE_BLE
#endif
#define ENABLE_LE_PERIPHERAL
#define ENABLE_PRINTF_HEXDUMP     // required by btstack's embedded hci_dump

// Buffer sizes and table limits
#define HCI_OUTGOING_PRE_BUFFER_SIZE 4
#define HCI_ACL_PAYLOAD_SIZE (255 + 4)
#define HCI_ACL_CHUNK_SIZE_ALIGNMENT 4
#define MAX_NR_GATT_CLIENTS 0
#define MAX_NR_HCI_CONNECTIONS 1
#define MAX_NR_L2CAP_SERVICES 0
#define MAX_NR_L2CAP_CHANNELS 0
#define MAX_NR_WHITELIST_ENTRIES 1
#define MAX_NR_LE_DEVICE_DB_ENTRIES 1
#define MAX_NR_SM_LOOKUP_ENTRIES 3
#define MAX_ATT_DB_SIZE 512

// Link keys live in a flash bank managed by pico_btstack_flash_bank
#define NVM_NUM_DEVICE_DB_ENTRIES 16
#define NVM_NUM_LINK_KEYS 16

#endif
