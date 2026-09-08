from __future__ import annotations

import argparse
import json
import re
import time

import serial


TEMP = re.compile(r"T:([-+]?\d+(?:\.\d+)?)\s*/([-+]?\d+(?:\.\d+)?).*?B:([-+]?\d+(?:\.\d+)?)\s*/([-+]?\d+(?:\.\d+)?)")


def send(printer: serial.Serial, command: str, timeout: float = 30) -> list[str]:
    printer.write(f"{command}\n".encode("ascii"))
    printer.flush()
    deadline = time.monotonic() + timeout
    lines: list[str] = []
    while time.monotonic() < deadline:
        raw = printer.readline()
        if not raw:
            continue
        line = raw.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        lines.append(line)
        if line.lower().startswith("ok"):
            return lines
    raise TimeoutError(f"No acknowledgement for {command}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only KINO Print hardware check")
    parser.add_argument("--port", default="COM11")
    args = parser.parse_args()
    with serial.Serial(args.port, 115200, timeout=1, write_timeout=10) as printer:
        time.sleep(2.5)
        printer.reset_input_buffer()
        identity = send(printer, "M115")
        temperature = send(printer, "M105")
        sd_status = send(printer, "M27")
    identity_text = " | ".join(identity)
    temperature_text = " | ".join(temperature)
    match = TEMP.search(temperature_text)
    if "Prusa i3 MK3" not in identity_text:
        raise RuntimeError("COM port did not identify as a Prusa i3 MK3/MK3S")
    if not match:
        raise RuntimeError("Printer did not return a complete temperature report")
    result = {
        "port": args.port,
        "identity": identity_text,
        "hotend": float(match.group(1)),
        "hotend_target": float(match.group(2)),
        "bed": float(match.group(3)),
        "bed_target": float(match.group(4)),
        "sd_status": " | ".join(sd_status),
        "commands": ["M115", "M105", "M27"],
    }
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
