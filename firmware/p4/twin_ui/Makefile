# KINO Twin's device screen: the P4 firmware's own ui.c, compiled to
# WebAssembly and stepped from the browser.
#
#   make WASI_SDK=/path/to/wasi-sdk-34.0-arm64-macos        -> kino-ui.wasm
#   make ICONS=w98 ...                                       -> private variant
#                                                               with the real
#                                                               menu artwork
#
# Same idea as ../host_preview: ui.c is #included by twin_ui.c so its static
# drawing functions and module state are reachable without adding test hooks
# to the firmware, and mesh3d.c, icons.c, qr.c and pure.c are compiled for
# real. The difference is what happens around draw_screen(): the harness
# steps ui_pass() (ui.c's loop body) once per host tick, feeds it a touch
# point and the simulator's state, and hands every frame it presents back to
# the page with the virtual time it was presented at.
#
# Toolchain: wasi-sdk (https://github.com/WebAssembly/wasi-sdk/releases),
# pinned in ../../../scripts/bake-twin-ui.mjs, which is how the artifact in
# apps/twin is (re)built and checked.
WASI_SDK ?= $(error set WASI_SDK to a wasi-sdk root, e.g. WASI_SDK=$$HOME/wasi-sdk-34.0-arm64-macos)
# Quoted: the checkout path may contain spaces (a scratch workspace does).
CC := "$(WASI_SDK)/bin/clang"
ICONS ?= placeholder

MAIN := ../main
KDP_CORE := ../../components/kdp_core/include
HOST_SHIM := ../host_preview/shim
VERSION := $(shell tr -d '\r\n' < ../../VERSION)

ifeq ($(ICONS),w98)
ICON_INC :=
else
# Forced in ahead of everything: icons.h says #include "icons_w98.h", and a
# quoted include looks beside icons.h first, so a -I path could never win.
# With the stand-in already included its guard makes the real header a no-op.
ICON_INC := -include icons_placeholder/icons_w98.h
endif

# -Wno-unknown-attributes: ui.c carries a GCC `optimize` attribute clang has
# no equivalent for. Same warning host_preview shows under clang; harmless.
CFLAGS := --target=wasm32-wasip1 -O2 -std=gnu11 -Wall -Wno-unused-function -Wno-unknown-attributes \
          -mexec-model=reactor \
          -I shim $(ICON_INC) -I $(HOST_SHIM) -I $(MAIN) -I $(KDP_CORE) \
          -DKINO_FW_VERSION=\"$(VERSION)\" -DKINO_TWIN_UI=1
# The canvas, a snapshot for dissolves, the frame ring and the gallery tiles
# are the bulk of the memory; 64 MB leaves room for the photograph frames.
LDFLAGS := -Wl,--no-entry -Wl,--initial-memory=33554432 -Wl,--max-memory=134217728 -Wl,--export=__heap_base -lm

SRCS := twin_ui.c $(MAIN)/mesh3d.c $(MAIN)/icons.c $(MAIN)/qr.c $(MAIN)/pure.c
DEPS := $(SRCS) $(MAIN)/ui.c $(MAIN)/ui.h $(MAIN)/mesh3d.h $(MAIN)/icons.h \
        $(MAIN)/ui_font.h $(MAIN)/ui_labels.h $(MAIN)/logo_kino_d4.h \
        $(MAIN)/guest.h $(MAIN)/conditions.h $(MAIN)/calibrate.h \
        $(MAIN)/icons_w98.h $(MAIN)/meta.h $(MAIN)/qr.h $(MAIN)/net_link.h \
        $(MAIN)/wifi_creds.h $(MAIN)/roll_state.h $(MAIN)/upload_queue.h \
        $(MAIN)/roll_queue.h $(MAIN)/gallery.h $(MAIN)/audio.h \
        $(MAIN)/kdp_server.h $(MAIN)/kdp_recipes.h $(MAIN)/pure.h \
        $(KDP_CORE)/kdp/protocol.h icons_placeholder/icons_w98.h \
        $(wildcard shim/*.h shim/freertos/*.h) Makefile ../../VERSION

kino-ui.wasm: $(DEPS)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $(SRCS)

clean:
	rm -f kino-ui.wasm

.PHONY: clean
