"""Stream one .gcode to an MK3S over USB serial, from a shell.

The predecessor of `apps/prusa-print-98` (KINO Print), kept because it is the
one-file version: no Electron, no window, no packaging - a port, a baud rate
and a file. Useful at the bench when the question is whether the printer
answers at all.

It does what the app's `print_worker.py` does, less well: it detects thermal
runaway, MINTEMP and MAXTEMP in the printer's replies, cools down and closes
the port on any failure, and holds Windows awake for the duration. It has none
of the app's PETG preflight, so it will happily stream a job whose first layer
is too hot - which is what the app was written to stop.

PORT and BAUD below are hard-coded. Do not point it at a port something else
is holding.
"""

import ctypes
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import serial


PORT = "COM11"
BAUD = 115200
GCODE = Path(r"C:\Users\AlexanderMoravcik\Desktop\KINO_DOOR_JOINT_COUPON_0.15mm_PETG_MK3S_7h27m.gcode")
LOG = Path(__file__).with_name("usb_print.log")


def log(message):
    stamp = datetime.now().isoformat(timespec="seconds")
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(f"{stamp} {message}\n")
        handle.flush()


def clean(line):
    return line.split(";", 1)[0].strip()


def wait_ok(printer, timeout=180):
    deadline = time.monotonic() + timeout
    responses = []
    while time.monotonic() < deadline:
        raw = printer.readline()
        if not raw:
            continue
        text = raw.decode("utf-8", errors="replace").strip()
        if not text:
            continue
        responses.append(text)
        low = text.lower()
        if low.startswith("ok"):
            return responses
        if "error:" in low or low.startswith("!!"):
            raise RuntimeError("printer error: " + text)
    raise TimeoutError("printer did not acknowledge command; last responses: " + " | ".join(responses[-8:]))


def send(printer, command, timeout=180):
    printer.write((command + "\n").encode("ascii", errors="strict"))
    printer.flush()
    return wait_ok(printer, timeout)


def emergency_cooldown(printer):
    for command in ("M104 S0", "M140 S0", "M107", "M84"):
        try:
            printer.write((command + "\n").encode("ascii"))
            printer.flush()
            time.sleep(0.15)
        except Exception:
            pass


def main():
    if not GCODE.is_file():
        raise FileNotFoundError(GCODE)
    ctypes.windll.kernel32.SetThreadExecutionState(0x80000001 | 0x00000002)
    printer = None
    try:
        log(f"OPEN {PORT} {BAUD} file={GCODE}")
        printer = serial.Serial(PORT, BAUD, timeout=1, write_timeout=15)
        time.sleep(2.5)
        printer.reset_input_buffer()
        identity = send(printer, "M115", 20)
        log("CONNECTED " + " | ".join(identity))
        status = send(printer, "M27", 20)
        log("STATUS " + " | ".join(status))

        total_bytes = GCODE.stat().st_size
        sent = 0
        commands = 0
        with GCODE.open("r", encoding="utf-8", errors="replace") as source:
            for raw in source:
                sent += len(raw.encode("utf-8", errors="replace"))
                command = clean(raw)
                if not command or command.startswith(";"):
                    continue
                responses = send(printer, command, 300)
                commands += 1
                if commands == 1:
                    log(f"PRINT_STARTED first={command}")
                if commands % 1000 == 0:
                    log(f"PROGRESS commands={commands} bytes={sent}/{total_bytes} percent={sent * 100 / total_bytes:.2f}")
                for response in responses:
                    low = response.lower()
                    if "error:" in low or "thermal runaway" in low or "mintemp" in low or "maxtemp" in low:
                        raise RuntimeError(response)
        log(f"COMPLETE commands={commands}")
    except Exception as exc:
        log(f"FAILED {type(exc).__name__}: {exc}")
        if printer is not None and printer.is_open:
            emergency_cooldown(printer)
        raise
    finally:
        if printer is not None and printer.is_open:
            printer.close()
        ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)


if __name__ == "__main__":
    main()
