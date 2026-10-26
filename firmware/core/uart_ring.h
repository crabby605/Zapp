#ifndef UART_RING_H
#define UART_RING_H
#include <stdint.h>
#include <stdbool.h>
#define HAL_UART_RX_BUF 256

// Single-producer/single-consumer byte ring. Two instances exist: one carries
// VM debug output from core 1 to core 0, one buffers UART RX from the ISR.
typedef struct {
    uint8_t  buf[HAL_UART_RX_BUF];
    volatile uint16_t head;
    volatile uint16_t tail;
} UartRing;

// VM (core 1) debug output, drained by the REPL on core 0.
extern UartRing uart_ring_debug;

void     uart_ring_init(UartRing *r);
bool     uart_ring_push(UartRing *r, uint8_t data);
bool     uart_ring_pop(UartRing *r, uint8_t *data);
uint16_t uart_ring_available(const UartRing *r);
void     uart_ring_flush(UartRing *r);
#endif
