from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path

import serial
from serial.tools import list_ports

from gcode_info import inspect_gcode, is_mk3s_job


def ports() -> list[dict[str, object]]:
    return [
        {
            "device": port.device,
            "description": port.description,
            "manufacturer": port.manufacturer,
            "vid": port.vid,
            "pid": port.pid,
            "serialNumber": port.serial_number,
            "isPrusa": port.vid == 0x2C99 or "prusa" in (port.description or "").lower(),
        }
        for port in list_ports.comports()
    ]


def cooldown(requested_port: str | None) -> dict[str, object]:
    available = list(list_ports.comports())
    selected = next((port.device for port in available if port.device == requested_port), None)
    if not selected:
        selected = next(
            (
                port.device
                for port in available
                if port.vid == 0x2C99 or "prusa" in (port.description or "").lower()
            ),
            None,
        )
    if not selected:
        raise RuntimeError("The Prusa is not connected. Turn the printer off at its power switch.")

    printer = serial.Serial(selected, 115200, timeout=1, write_timeout=5)
    try:
        time.sleep(2.5)
        printer.reset_input_buffer()
        for command in ("M108", "M104 S0", "M140 S0", "M107", "M84"):
            printer.write((command + "\n").encode("ascii"))
            printer.flush()
            time.sleep(0.15)
        printer.write(b"M105\n")
        printer.flush()
        deadline = time.monotonic() + 8
        replies: list[str] = []
        while time.monotonic() < deadline:
            line = printer.readline().decode("utf-8", errors="replace").strip()
            if line:
                replies.append(line)
                if line.lower().startswith("ok") and "T:" in line:
                    break
        report = " | ".join(replies)
        targets = re.search(r"T:[-+]?\d+(?:\.\d+)?\s*/([-+]?\d+(?:\.\d+)?).*?B:[-+]?\d+(?:\.\d+)?\s*/([-+]?\d+(?:\.\d+)?)", report)
        if not targets or float(targets.group(1)) != 0 or float(targets.group(2)) != 0:
            detail = report or "no response"
            raise RuntimeError(f"Heater-off commands were sent, but zero targets could not be confirmed. Printer reply: {detail}")
        return {"ok": True, "port": selected, "reply": report}
    finally:
        printer.close()


def diagnose(path: str) -> dict[str, object]:
    info = inspect_gcode(path)
    first_commands: list[str] = []
    with Path(path).open("r", encoding="utf-8", errors="replace") as source:
        for raw in source:
            command = raw.split(";", 1)[0].strip()
            if command:
                first_commands.append(command)
            if len(first_commands) >= 500:
                break

    def position(prefix: str) -> int | None:
        return next((i for i, command in enumerate(first_commands) if command.upper().startswith(prefix)), None)

    m104, m109, m190, g80 = (position(name) for name in ("M104", "M109", "M190", "G80"))
    issues: list[dict[str, str]] = []
    if m104 is not None and m190 is not None and m104 < m190:
        issues.append({
            "id": "early-hotend",
            "severity": "warning",
            "title": "Nozzle heats before the bed is ready",
            "detail": "The nozzle can sit hot for several minutes and ooze onto the bed.",
            "fix": "Keep the nozzle at 170°C until leveling is done.",
        })
    if m109 is not None and g80 is not None and m109 < g80:
        issues.append({
            "id": "hot-probing",
            "severity": "warning",
            "title": "Nozzle is fully hot during leveling",
            "detail": "Oozed filament can catch on the nozzle or spoil the first layer.",
            "fix": "Heat to print temperature after leveling.",
        })
    try:
        sliced_temp = int(float(info.nozzle_temperature))
    except ValueError:
        sliced_temp = 230
    if info.filament_type.upper() == "PETG" and sliced_temp >= 240:
        issues.append({
            "id": "hot-petg",
            "severity": "advisory",
            "title": f"First layer nozzle temperature: {sliced_temp}°C",
            "detail": "That is the hot end of this PETG profile and makes idle ooze more likely.",
            "fix": "Start at 230°C. Raise it in 5°C steps only if layers do not bond well.",
        })
    if not is_mk3s_job(info):
        issues.append({
            "id": "printer-mismatch",
            "severity": "error",
            "title": "Wrong printer profile",
            "detail": f"This file uses {info.printer_profile}.",
            "fix": "Slice it again for Original Prusa i3 MK3S/MK3S+.",
        })

    return {
        **info.to_dict(),
        "issues": issues,
        "recommendedNozzle": 230 if info.filament_type.upper() == "PETG" and sliced_temp > 235 else sliced_temp,
        "recommendedAntiOoze": bool(m104 is not None and m190 is not None and m104 < m190),
        "safeToPrint": not any(issue["severity"] == "error" for issue in issues),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["ports", "inspect", "cooldown"])
    parser.add_argument("--file")
    parser.add_argument("--port")
    args = parser.parse_args()
    if args.command == "ports":
        result = ports()
    elif args.command == "inspect":
        if not args.file:
            parser.error("--file is required for inspect")
        result = diagnose(args.file)
    else:
        result = cooldown(args.port)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
