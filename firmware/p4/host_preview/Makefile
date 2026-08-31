# Render the camera's screens natively, using the firmware's own drawing code.
#
#   make && ./preview out/
#
# mesh3d.c is compiled for real; ui.c is #included by preview.c so its static
# drawing functions are reachable without adding test hooks to the firmware.
CC ?= gcc
MAIN := ../main
# kdp_core's public headers are on the include path rather than shimmed: the
# About screen reports KDP_PROTOCOL_VERSION, and kdp/protocol.h needs nothing
# but stdint.h. A shim would be a second copy of a number whose whole point is
# that there is one of it.
KDP_CORE := ../../components/kdp_core/include
CFLAGS := -O2 -std=gnu11 -Wall -Wno-unused-function -I shim -I $(MAIN) -I $(KDP_CORE)
LDFLAGS := -lm

# qr.c is compiled for real, not stubbed: it has no ESP-IDF dependency, and a
# stub would defeat the point — the QR on the ROLL screen has never been on a
# panel, so these renders are the only place its pitch and quiet zone can be
# looked at.
SRCS := preview.c $(MAIN)/mesh3d.c $(MAIN)/icons.c $(MAIN)/qr.c
DEPS := $(SRCS) $(MAIN)/ui.c $(MAIN)/ui.h $(MAIN)/mesh3d.h $(MAIN)/icons.h \
        $(MAIN)/ui_font.h $(MAIN)/ui_labels.h $(MAIN)/logo_kino_d4.h \
        $(MAIN)/icons_w98.h $(MAIN)/meta.h $(MAIN)/qr.h $(MAIN)/net_link.h \
        $(MAIN)/wifi_creds.h $(MAIN)/roll_state.h $(MAIN)/upload_queue.h \
        $(MAIN)/roll_queue.h $(MAIN)/gallery.h $(MAIN)/audio.h \
        $(MAIN)/kdp_server.h $(MAIN)/kdp_recipes.h $(KDP_CORE)/kdp/protocol.h

# Every source and header is listed, including the ones that are #included
# rather than compiled: a missing prerequisite here means make silently
# reports success and reruns the previous binary, which looks exactly like a
# change that had no effect.
preview: $(DEPS)
	$(CC) $(CFLAGS) -o $@ $(SRCS) $(LDFLAGS)

clean:
	rm -f preview *.ppm

.PHONY: clean
