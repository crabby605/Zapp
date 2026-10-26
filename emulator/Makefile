# Builds the Zapp emulator: the firmware VM linked against a virtual board.
CC     ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -O1 -I../firmware/core -I../firmware/rp2040

zapp-emu: zapp_emu.c ../firmware/core/vm.c ../firmware/core/vm.h ../firmware/core/hal.h ../firmware/core/config.h
	$(CC) $(CFLAGS) -DZAPP_EMULATOR -o $@ zapp_emu.c ../firmware/core/vm.c -lm

clean:
	rm -f zapp-emu

.PHONY: clean
