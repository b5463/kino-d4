# Host tests for the P4 firmware's pure logic. Same shape as
# firmware/components/kdp_core/host_tests: plain compiler, no framework.
#
#   make -C firmware/p4/host_tests test
#
# pure.c compiles natively because it has no ESP-IDF dependency — that is the
# reason it exists as its own translation unit. Anything that needs FreeRTOS,
# the JPEG codec, the PPA, SDMMC or NVS is deliberately not here; see
# ../main/pure.h.
CC ?= cc
CFLAGS ?= -std=c99 -Wall -Wextra -Werror -O2
MAIN = ../main
SRC = $(MAIN)/pure.c test_pure.c

test_pure: $(SRC) $(MAIN)/pure.h
	$(CC) $(CFLAGS) -I$(MAIN) $(SRC) -o $@

.PHONY: test clean
test: test_pure
	./test_pure

clean:
	rm -f test_pure
