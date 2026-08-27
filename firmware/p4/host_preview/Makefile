# Render the camera's screens natively, using the firmware's own drawing code.
#
#   make && ./preview out/
#
# mesh3d.c is compiled for real; ui.c is #included by preview.c so its static
# drawing functions are reachable without adding test hooks to the firmware.
CC ?= gcc
MAIN := ../main
CFLAGS := -O2 -std=gnu11 -Wall -Wno-unused-function -I shim -I $(MAIN)
LDFLAGS := -lm

SRCS := preview.c $(MAIN)/mesh3d.c $(MAIN)/icons.c
DEPS := $(SRCS) $(MAIN)/ui.c $(MAIN)/ui.h $(MAIN)/mesh3d.h $(MAIN)/icons.h \
        $(MAIN)/ui_font.h $(MAIN)/ui_labels.h $(MAIN)/logo_kino_d4.h \
        $(MAIN)/icons_w98.h $(MAIN)/meta.h

# Every source and header is listed, including the ones that are #included
# rather than compiled: a missing prerequisite here means make silently
# reports success and reruns the previous binary, which looks exactly like a
# change that had no effect.
preview: $(DEPS)
	$(CC) $(CFLAGS) -o $@ $(SRCS) $(LDFLAGS)

clean:
	rm -f preview *.ppm

.PHONY: clean
