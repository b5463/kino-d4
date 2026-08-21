CC ?= cc
CFLAGS ?= -std=c99 -Wall -Wextra -Werror -O2
SRC = ../src/crc32.c ../src/packet.c ../src/decoder.c test_kdp.c

test_kdp: $(SRC) ../include/kdp/*.h
	$(CC) $(CFLAGS) -I../include $(SRC) -o $@

.PHONY: test clean
test: test_kdp
	./test_kdp

clean:
	rm -f test_kdp
