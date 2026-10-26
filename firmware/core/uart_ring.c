#include "uart_ring.h"
#include <string.h>

// The fences keep the other core from seeing a moved index before the byte
// it guards.
#define __dmb() __atomic_thread_fence(__ATOMIC_SEQ_CST)

UartRing uart_ring_debug;

void uart_ring_init(UartRing *r) {
    r->head = 0;
    r->tail = 0;
    memset(r->buf, 0, sizeof(r->buf));
}

bool uart_ring_push(UartRing *r, uint8_t data) {
    uint16_t next_head = (uint16_t)((r->head + 1) % HAL_UART_RX_BUF);
    if (next_head == r->tail) return false;
    r->buf[r->head] = data;
    __dmb();  // Ensure data is written before head is updated
    r->head = next_head;
    return true;
}

bool uart_ring_pop(UartRing *r, uint8_t *data) {
    if (r->head == r->tail) return false;
    __dmb();  // Ensure we read data after seeing the updated head
    *data = r->buf[r->tail];
    __dmb();  // Ensure data is read before tail is updated
    r->tail = (uint16_t)((r->tail + 1) % HAL_UART_RX_BUF);
    return true;
}

uint16_t uart_ring_available(const UartRing *r) {
    uint16_t head = r->head, tail = r->tail;
    return (head >= tail) ? (uint16_t)(head - tail)
                          : (uint16_t)(HAL_UART_RX_BUF - (tail - head));
}

void uart_ring_flush(UartRing *r) {
    r->tail = r->head;
}
