# Render the camera's screens natively, using the firmware's own drawing code.
#
#   make && ./preview out/      every scene for both hands: out/*.ppm is the
#                               right hand, out/left/*.ppm the left; the audit
#                               report goes to stderr
#   make check                  render into out/ and compare every PPM with
#                               golden.sha256; fails on any changed picture
#   make approve                render into out/ and make this tree's PPMs the
#                               new golden.sha256
#
# ui.c is #included by preview.c so its static drawing functions are reachable
# without adding test hooks to the firmware.
#
# golden.sha256 is local and not committed. The renders are deterministic on
# one toolchain - two runs give the same bytes - but not across them: WSL's
# gcc 9.4 and CI's gcc round the float maths in the anti-aliasing differently,
# so a manifest approved on one fails on the other for no change at all. The
# workflow is: `make approve` on the commit you start from, change the code,
# `make check`. An empty diff proves a refactor drew nothing different; a
# non-empty one lists exactly the pictures to look at. CI runs what does hold
# across compilers: the audit's structural checks and the PPM count.
CC ?= gcc
MAIN := ../main
# kdp_core's public headers are on the include path rather than shimmed: the
# About screen reports KDP_PROTOCOL_VERSION, and kdp/protocol.h needs nothing
# but stdint.h. A shim would be a second copy of a number whose whole point is
# that there is one of it.
KDP_CORE := ../../components/kdp_core/include
CFLAGS := -O2 -std=gnu11 -Wall -Wno-unused-function -I shim -I $(MAIN) -I $(KDP_CORE)
# The audit (preview.c). text() reports every string it sets: its box, which
# fails the run when it leaves the safe area, and its ink, which is measured
# against the pixels it lands on. Every screen's hit map is swept for targets
# under 52 px and for hand-side chrome on the wrong half or stretched across
# to the far edge, for both hands.
# A contrast pair under its floor or a target under 52 px fails the run, like
# the structural checks (#234 closed #176's list). Renderer only:
# on the camera it would be a check nobody reads, and here it is a check that
# runs over every screen the product has every time somebody looks at one.
CFLAGS += -DKINO_UI_AUDIT=1
# The radio build, because that is the one that ships. conditions.h gates the
# "Uploads have no server" row on KINO_RADIO (#198), so without this the
# renderer cannot draw a screen the product has. Nothing else in the UI is
# behind the flag; the network modules it also gates are not compiled here.
CFLAGS += -DKINO_RADIO=1
LDFLAGS := -lm

# qr.c is compiled for real, not stubbed: it has no ESP-IDF dependency, and a
# stub would defeat the point — the QR on the ROLL screen has never been on a
# panel, so these renders are the only place its pitch and quiet zone can be
# looked at.
# pure.c is compiled for real for the same reason qr.c is, and now it has to
# be: the photograph screen's wigglegram order comes from pure_wiggle_sequence()
# on the draw path, so a stub would mean the renders showed an order no camera
# will ever play. It has no ESP-IDF dependency - that is what it is for.
SRCS := preview.c $(MAIN)/qr.c $(MAIN)/pure.c
DEPS := $(SRCS) $(MAIN)/ui.c $(MAIN)/ui.h \
        $(MAIN)/ui_font.h $(MAIN)/logo_kino_d4.h \
        $(MAIN)/ui_theme.h $(MAIN)/ui_palette.h \
        $(MAIN)/conditions.h $(MAIN)/calibrate.h \
        $(MAIN)/meta.h $(MAIN)/qr.h $(MAIN)/net_link.h \
        $(MAIN)/wifi_creds.h $(MAIN)/roll_state.h $(MAIN)/upload_queue.h \
        $(MAIN)/roll_queue.h $(MAIN)/gallery.h $(MAIN)/audio.h \
        $(MAIN)/kdp_server.h $(MAIN)/kdp_recipes.h $(MAIN)/pure.h \
        $(KDP_CORE)/kdp/protocol.h \
        $(wildcard shim/*.h shim/freertos/*.h) Makefile

# Every source and header is listed, including the ones that are #included
# rather than compiled: a missing prerequisite here means make silently
# reports success and reruns the previous binary, which looks exactly like a
# change that had no effect.
preview: $(DEPS)
	$(CC) $(CFLAGS) -o $@ $(SRCS) $(LDFLAGS)

OUT := out
GOLDEN := golden.sha256

# One render into a clean out/, and the manifest of what it drew: one line per
# PPM, both hands, sorted by path. The scene log goes to out/preview.log; the
# audit report stays on the terminal.
render: preview
	rm -rf $(OUT)
	mkdir -p $(OUT)
	./preview $(OUT) > $(OUT)/preview.log
	cd $(OUT) && find . -name '*.ppm' | LC_ALL=C sort | xargs sha256sum > render.sha256
	@echo "render: $$(wc -l < $(OUT)/render.sha256) PPMs in $(OUT)/"

check: render
	@test -f $(GOLDEN) || { echo "check: no $(GOLDEN). Run 'make approve' on the commit you trust first."; exit 1; }
	@if cmp -s $(GOLDEN) $(OUT)/render.sha256; then \
	  echo "check: all $$(wc -l < $(GOLDEN)) PPMs match $(GOLDEN)"; \
	else \
	  echo "check: renders differ from $(GOLDEN) (< approved, > this tree):"; \
	  diff $(GOLDEN) $(OUT)/render.sha256 | sed -n 's/^\([<>]\) [0-9a-f]*  \.\//  \1 /p'; \
	  exit 1; \
	fi

approve: render
	cp $(OUT)/render.sha256 $(GOLDEN)
	@echo "approve: $(GOLDEN) holds this tree's $$(wc -l < $(GOLDEN)) PPMs"

clean:
	rm -rf preview *.ppm $(OUT)

.PHONY: render check approve clean
