// Host shim. One memory here, so the placement attributes are empty.
// ui.c puts its camera snapshot in PSRAM with EXT_RAM_BSS_ATTR.
#pragma once
#define EXT_RAM_BSS_ATTR
