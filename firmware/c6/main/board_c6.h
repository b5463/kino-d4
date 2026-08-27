// ESP32-C6 pin map for the KINO D4 V1 radio coprocessor.
//
// Unlike firmware/p4/main/board_d4v1.h, nothing in this file is provisional.
// The C6's SDIO *slave* peripheral is not routable through the GPIO matrix —
// it is wired to fixed IOMUX pads — so these six numbers are a property of
// the die, not of the Guition carrier. That is the whole reason this image
// can be built while the P4-side host cannot: see firmware/C6_HARDWARE_MAP.md.
//
// Source: ESP32-C6 Technical Reference Manual, SDIO slave chapter.
#ifndef BOARD_C6_H
#define BOARD_C6_H

// --- SDIO slave (fixed in silicon, NOT configurable) ---
#define BOARD_C6_SDIO_CLK 19
#define BOARD_C6_SDIO_CMD 18
#define BOARD_C6_SDIO_DAT0 20
#define BOARD_C6_SDIO_DAT1 21
#define BOARD_C6_SDIO_DAT2 22
#define BOARD_C6_SDIO_DAT3 23

// --- Boot strap ---
// GPIO9 is the C6's download-mode strap, and the carrier's `C6_IO9` header net
// is consistent with being exactly that. No firmware here drives it; it is
// named so nothing else claims it.
#define BOARD_C6_BOOT_STRAP 9

#endif  // BOARD_C6_H
