# Host tests for the P4 firmware. Same shape as
# firmware/components/kdp_core/host_tests: plain compiler, no framework.
#
#   make -C firmware/p4/host_tests test        # pure logic, no dependencies
#   make -C firmware/p4/host_tests test-queue  # Roll upload queue, no deps
#   make -C firmware/p4/host_tests test-meta   # JSON mappings, needs cJSON
#   make -C firmware/p4/host_tests test-net    # C6 state model + credentials
#   make -C firmware/p4/host_tests test-report # the radio seam net_hosted uses
#   make -C firmware/p4/host_tests test-qr     # QR encoder vs. reference data
#   make -C firmware/p4/host_tests test-store  # UPLOAD.JSON record, needs cJSON
#   make -C firmware/p4/host_tests test-all    # all seven
#
# Several targets because they have different dependencies, not because the
# later ones are optional:
#
#   test       pure.c has no ESP-IDF dependency at all - that is why it exists
#              as its own translation unit. Runs anywhere a C compiler does.
#
#   test-queue roll_queue.c is the Roll upload queue's state machine, held to
#              the same no-ESP-IDF rule for the same reason. It is currently
#              the ONLY proof any of the queue behaves: the C6 transport is
#              not routed on this carrier (firmware/C6_HARDWARE_MAP.md), so no
#              upload has ever run on hardware.
#
#   test-qr    qr.c has no ESP-IDF dependency either, and this is the only
#              place its correctness is established: a QR with one wrong module
#              looks right on the panel and scans on nothing. The references it
#              compares against come from the `qrcode` npm package, so the test
#              is not the encoder agreeing with itself.
#
#   test-store upload_store.c is the UPLOAD.JSON record - the on-card half of
#              the upload queue, and the only half that touches a parser. Same
#              cJSON rule as test-meta below, for the same reason: a record
#              read back through a different parser than the device uses would
#              leave exactly the gap this test exists to close. A record
#              believed when it should not be uploads a frame twice.
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
QUEUE_SRC = $(MAIN)/roll_queue.c test_roll_queue.c
# net_link.c reaches esp_err.h and nothing else from ESP-IDF - shim/ has it,
# the same one meta.c needs. Time is injected, so there is no esp_timer here.
NET_SRC = $(MAIN)/net_link.c $(MAIN)/pure.c test_net_link.c
# The same net_link.c with a stub radio driver registered, which is the state
# machine the radio build runs. Separate from NET_SRC because test_net_link.c
# asserts what the camera reports with NO radio in the build, and that suite has
# to keep asserting exactly that, unchanged - it is what ships.
REPORT_SRC = $(MAIN)/net_link.c test_net_report.c
QR_SRC = $(MAIN)/qr.c test_qr.c
# meta.c reaches capture.h -> cam_link.h -> esp_err.h, and nothing else from
# ESP-IDF. shim/ provides exactly that one header.
META_SRC = $(MAIN)/meta.c test_meta.c $(CJSON_DIR)/cJSON.c
# upload_store.c reaches nothing from ESP-IDF except cJSON - no FreeRTOS, no
# storage.h, no clock. That is the whole point of the split; see upload_store.h.
STORE_SRC = $(MAIN)/upload_store.c $(MAIN)/roll_queue.c test_upload_store.c             $(CJSON_DIR)/cJSON.c

test_pure: $(PURE_SRC) $(MAIN)/pure.h
	$(CC) $(CFLAGS) -I$(MAIN) $(PURE_SRC) -o $@

test_meta: $(META_SRC) $(MAIN)/meta.h $(MAIN)/capture.h
	$(CC) $(CFLAGS) -I$(MAIN) -I$(SHIM) -I$(CJSON_DIR) $(META_SRC) -o $@ -lm

# fsync()/fileno() are POSIX, not C99, and -std=c99 hides them. The firmware
# gets them from ESP-IDF's default gnu dialect; here they have to be asked for.
test_upload_store: $(STORE_SRC) $(MAIN)/upload_store.h $(MAIN)/roll_queue.h
	$(CC) $(CFLAGS) -D_POSIX_C_SOURCE=200809L -I$(MAIN) -I$(CJSON_DIR) $(STORE_SRC) -o $@ -lm

test_roll_queue: $(QUEUE_SRC) $(MAIN)/roll_queue.h
	$(CC) $(CFLAGS) -I$(MAIN) $(QUEUE_SRC) -o $@

test_net_link: $(NET_SRC) $(MAIN)/net_link.h $(MAIN)/pure.h
	$(CC) $(CFLAGS) -I$(MAIN) -I$(SHIM) $(NET_SRC) -o $@

test_net_report: $(REPORT_SRC) $(MAIN)/net_link.h
	$(CC) $(CFLAGS) -I$(MAIN) -I$(SHIM) $(REPORT_SRC) -o $@

test_qr: $(QR_SRC) $(MAIN)/qr.h
	$(CC) $(CFLAGS) -I$(MAIN) $(QR_SRC) -o $@

.PHONY: test test-queue test-net test-report test-qr test-meta test-store test-all clean
test: test_pure
	./test_pure

test-queue: test_roll_queue
	./test_roll_queue

test-net: test_net_link
	./test_net_link

test-report: test_net_report
	./test_net_report

test-qr: test_qr
	./test_qr

test-meta: test_meta
	./test_meta

test-store: test_upload_store
	./test_upload_store

test-all: test test-queue test-net test-report test-qr test-meta test-store

clean:
	rm -f test_pure test_roll_queue test_net_link test_net_report test_qr test_meta test_upload_store
