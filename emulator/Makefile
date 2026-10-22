# Builds the Zapp emulator: the firmware VM linked against a virtual board.
CC     ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -O1 -I../include

zapp-emu: zapp_emu.c ../src/vm.c ../include/vm.h ../include/hal.h ../include/config.h
	$(CC) $(CFLAGS) -DZAPP_EMULATOR -o $@ zapp_emu.c ../src/vm.c

clean:
	rm -f zapp-emu

.PHONY: clean
