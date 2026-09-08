# Carrier-board source

D4 V1 currently uses a perfboard or Perma-Proto-style carrier. No production PCB is released.

If the carrier becomes a PCB, commit:

- native KiCad project files;
- schematic and PCB plots;
- fabrication Gerbers and drill files;
- pick-and-place and assembly drawings where applicable;
- a board BOM tied to [`../BOM.csv`](../BOM.csv);
- design-rule settings;
- the locked GPIO map;
- high-current trace calculations and fuse placement;
- revision markings visible on the board.

The schematic must keep camera power switching, logic control, flash current, and battery power visually distinct. A rendered board image is useful review material. It is not source.

## KINO D4 Mainboard Rev 1.0

The first production-mainboard design phase lives in
[`kino-d4-mainboard-rev1/`](kino-d4-mainboard-rev1/). It is a KiCad 10
architecture baseline with a provisional board envelope and is explicitly not
released for fabrication.
