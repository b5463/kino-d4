# KINO Print

A print host for an Original Prusa i3 MK3S, running locally on Windows. It exists because the bodies in this repository kept failing on the bed for reasons the slicer does not warn about.

Electron, React, Tailwind. The interface is Windows 98, scaled to be readable on a 4K monitor.

## Start

Double-click `KINO Print.cmd`, or run `release-final/KINO Print/KINO Print.exe`. The folder is self-contained and can be copied anywhere on this PC.

Open a `.gcode` and it reads the PrusaSlicer metadata out of the file. It finds the Prusa's serial port itself. Before anything heats up it asks a person to confirm the printer is physically clear. Then it streams the job at 115200 baud.

The print worker is a separate process. Close the window and the print carries on, and Windows stays awake until it finishes.

## The PETG detector

This is the part that earns the application. It looks for four things:

- a first layer hotter than it should be;
- probing done at full temperature;
- a printer profile that does not match the machine;
- a nozzle that starts heating before the bed wait.

The repair plan drops a hot PETG job to 230 °C. It holds the nozzle at 170 °C while the bed heats and mesh levelling runs, then raises it just before the prime line.

The source `.gcode` is never modified. Repairs go into the stream.

## Safety

- Keep the PC powered and the cable connected for the whole print.
- Watch the heating, the homing and the first layer.
- Stop sends heaters off, fans off, motors disabled.
- If the stream dies, the worker runs the same cooldown.
- Pause stops sending moves and deliberately leaves the heaters on, so the nozzle does not cool into the part.

The View menu offers 100%, 125% and 150%. The default is 125%.

Runtime state and logs sit in the Electron user-data folder for `KINO Print`.

## Development

```bash
corepack npm run dev   -w @kino/print
corepack npm test      -w @kino/print     # Python, not vitest
corepack npm run build -w @kino/print
corepack npm run dist:win -w @kino/print
```

The test suite is `unittest` over the gcode reader and the printer read-only check, so a machine without Python cannot run it — which also means a bare `npm test` at the repository root fails there.

The bundled W95FA typeface is Alina Sava's, under OFL-1.1. Its notice and licence travel with it in `public/fonts/`; see [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md).
