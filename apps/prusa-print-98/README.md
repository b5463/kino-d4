# KINO Print

A finished local Windows desktop print host for an Original Prusa i3 MK3S,
built with Electron, React, and Tailwind CSS. The interface combines KINO D4
branding with crisp, scalable Windows 98 utility styling.

## Start

Double-click `KINO Print.cmd`, or run
`release-final/KINO Print/KINO Print.exe` directly. The application folder is
self-contained and can be copied to another location on this PC.

The app uses native Windows file dialogs, detects the Prusa serial port, reads
PrusaSlicer metadata from `.gcode` files, runs preflight diagnostics, asks for a
physical-safety confirmation, and streams the job at 115200 baud. The isolated
print worker remains active if the window closes and keeps Windows awake.

For PETG, the detector identifies unusually hot first layers, full-temperature
probing, printer-profile mismatches, and nozzle heating that begins before the
bed wait. The recommended repair plan defaults hot PETG jobs to 230°C and holds
the nozzle at 170°C while the bed heats and mesh leveling runs. It then raises
the nozzle immediately before the prime line. The source `.gcode` is never
modified.

The View menu offers 100%, 125%, and 150% interface sizes. The default is a
native, sharp 125% intended for high-resolution and 4K monitors.

## Safety and reliability

- Keep the PC powered and the USB cable connected for the entire print.
- Supervise heating, homing, and the first layer.
- Stop sends heater-off, fan-off, and motor-disable commands.
- If the stream fails, the worker attempts the same safe cooldown sequence.
- Pause stops sending new moves but deliberately keeps the heaters active.

Runtime state and logs are stored under the Electron user-data folder for
`KINO Print`.

## Development

- `corepack npm run dev -w @kino/print`
- `corepack npm test -w @kino/print`
- `corepack npm run build -w @kino/print`
- `corepack npm run dist:win -w @kino/print`
