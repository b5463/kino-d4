# Host tests for the P4 firmware. Same shape as
# firmware/components/kdp_core/host_tests: plain compiler, no framework.
#
#   make -C firmware/p4/host_tests test        # pure logic, no dependencies
#   make -C firmware/p4/host_tests test-meta   # JSON mappings, needs cJSON
#   make -C firmware/p4/host_tests test-all    # both
#
# Two targets because they have different dependencies, not because the second
# is optional:
#
#   test       pure.c has no ESP-IDF dependency at all - that is why it exists
#              as its own translation unit. Runs anywhere a C compiler does.
#
#   test-meta  meta.c needs cJSON. Rather than vendor a copy that could drift
#              from the one the firmware links, this compiles against ESP-IDF's
#              own: $(IDF_PATH)/components/json/cJSON. So it runs inside the
#              espressif/idf container (where CI already builds the firmware)
#              or anywhere IDF_PATH is set. Testing the mapping against a
#              DIFFERENT cJSON than the device uses would leave exactly the
#              gap these tests exist to close.
#
# Locally, without a local IDF:
#   docker run --rm -v "$PWD:/project" -w /project/firmware/p4/host_tests \
#     espressif/idf:v5.5.1 make test-all
CC ?= cc
CFLAGS ?= -std=c99 -Wall -Wextra -Werror -O2
MAIN = ../main
# One header, so it cannot shadow ESP-IDF's real cJSON.h - see shim/esp_err.h.
SHIM = shim

IDF_PATH ?= /opt/esp/idf
CJSON_DIR ?= $(IDF_PATH)/components/json/cJSON

PURE_SRC = $(MAIN)/pure.c test_pure.c
# meta.c reaches capture.h -> cam_link.h -> esp_err.h, and nothing else from
# ESP-IDF. shim/ provides exactly that one header.
META_SRC = $(MAIN)/meta.c test_meta.c $(CJSON_DIR)/cJSON.c

test_pure: $(PURE_SRC) $(MAIN)/pure.h
	$(CC) $(CFLAGS) -I$(MAIN) $(PURE_SRC) -o $@

test_meta: $(META_SRC) $(MAIN)/meta.h $(MAIN)/capture.h
	$(CC) $(CFLAGS) -I$(MAIN) -I$(SHIM) -I$(CJSON_DIR) $(META_SRC) -o $@ -lm

.PHONY: test test-meta test-all clean
test: test_pure
	./test_pure

test-meta: test_meta
	./test_meta

test-all: test test-meta

clean:
	rm -f test_pure test_meta
