from __future__ import annotations

import argparse
import ctypes
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import serial
from serial.tools import list_ports

from gcode_info import inspect_gcode


ACTIVE = {"connecting", "heating", "printing", "paused", "stopping"}
WORKER_VERSION = "1.0.3-usb-failsafe"
TEMP = re.compile(r"T:([-+]?\d+(?:\.\d+)?)\s*/([-+]?\d+(?:\.\d+)?).*?B:([-+]?\d+(?:\.\d+)?)\s*/([-+]?\d+(?:\.\d+)?)")
POWER = re.compile(r"@:([-+]?\d+(?:\.\d+)?)\s+B@:([-+]?\d+(?:\.\d+)?)")
POSITION = re.compile(r"X:([-+]?\d+(?:\.\d+)?)\s+Y:([-+]?\d+(?:\.\d+)?)\s+Z:([-+]?\d+(?:\.\d+)?)\s+E:([-+]?\d+(?:\.\d+)?)")
NOZZLE_COMMAND = re.compile(r"^(M10[49])\b(.*?)(?:\s+S([-+]?\d+(?:\.\d+)?))(.*)$", re.I)
EXTRUSION_MOVE = re.compile(r"^G(?:0|1)\b.*(?:^|\s)E([-+]?\d+(?:\.\d+)?)", re.I)


class UserStopped(Exception):
    pass


def rewrite_nozzle_temperature(command: str, target: int) -> str:
    match = NOZZLE_COMMAND.match(command)
    if not match or float(match.group(3)) <= 0:
        return command
    return f"{match.group(1)}{match.group(2)} S{target}{match.group(4)}"


def is_positive_extrusion(command: str) -> bool:
    match = EXTRUSION_MOVE.search(command)
    return bool(match and float(match.group(1)) > 0)


def temp_value(value: object) -> str:
    return f"{float(value):.1f}°C" if isinstance(value, (int, float)) else "--"


def first_number(value: str, fallback: float) -> float:
    match = re.search(r"[-+]?\d+(?:\.\d+)?", value)
    return float(match.group(0)) if match else fallback


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def find_prusa_port(preferred: str) -> str | None:
    ports = list(list_ports.comports())
    if any(port.device == preferred for port in ports):
        return preferred
    prusa = next(
        (
            port.device
            for port in ports
            if port.vid == 0x2C99 or "prusa" in (port.description or "").lower()
        ),
        None,
    )
    return prusa


def atomic_json(path: Path, data: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(temp, path)


class Worker:
    def __init__(self, port: str, gcode: Path, state_path: Path, control_path: Path, nozzle_temp: int, anti_ooze: bool):
        self.port = port
        self.gcode = gcode
        self.state_path = state_path
        self.control_path = control_path
        self.nozzle_temp = nozzle_temp
        self.anti_ooze = anti_ooze
        self.printer: serial.Serial | None = None
        self.info = inspect_gcode(gcode)
        self.calibration_bed_target = first_number(self.info.bed_temperature, 85.0)
        self.state: dict[str, object] = {
            "status": "connecting",
            "message": "Connecting to printer…",
            "port": port,
            "baud": 115200,
            "file": str(gcode),
            "file_name": gcode.name,
            "progress": 0.0,
            "commands_sent": 0,
            "commands_total": self.info.command_count,
            "started_at": now(),
            "updated_at": now(),
            "hotend": None,
            "hotend_target": None,
            "bed": None,
            "bed_target": None,
            "hotend_power": None,
            "bed_power": None,
            "fan_percent": 0.0,
            "speed_percent": 100.0,
            "flow_percent": 100.0,
            "position_x": None,
            "position_y": None,
            "position_z": None,
            "current_layer": 0,
            "total_layers": self.info.total_layers,
            "layer_z": None,
            "remaining_minutes": None,
            "firmware_progress": None,
            "nozzle_override": nozzle_temp,
            "anti_ooze": anti_ooze,
            "worker_version": WORKER_VERSION,
            "phase": "connecting",
            "nozzle_interlock": "locked",
        }
        self.last_control_mtime = 0.0
        self.last_wait_update = 0.0

    def update(self, **changes: object) -> None:
        self.state.update(changes)
        self.state["updated_at"] = now()
        atomic_json(self.state_path, self.state)

    def parse_temperature(self, lines: list[str]) -> None:
        for line in lines:
            match = TEMP.search(line)
            if match:
                self.state.update(
                    hotend=float(match.group(1)),
                    hotend_target=float(match.group(2)),
                    bed=float(match.group(3)),
                    bed_target=float(match.group(4)),
                )
            power = POWER.search(line)
            if power:
                self.state.update(hotend_power=float(power.group(1)), bed_power=float(power.group(2)))
            position = POSITION.search(line)
            if position:
                self.state.update(
                    position_x=float(position.group(1)),
                    position_y=float(position.group(2)),
                    position_z=float(position.group(3)),
                )

    def parse_command_state(self, command: str) -> None:
        upper = command.upper()
        progress = re.search(r"(?:^|\s)P(\d+)", upper) if upper.startswith("M73") else None
        remaining = re.search(r"(?:^|\s)R(\d+)", upper) if upper.startswith("M73") else None
        if progress:
            self.state["firmware_progress"] = int(progress.group(1))
        if remaining:
            self.state["remaining_minutes"] = int(remaining.group(1))
        fan = re.search(r"(?:^|\s)S(\d+(?:\.\d+)?)", upper) if upper.startswith("M106") else None
        if fan:
            self.state["fan_percent"] = round(min(255.0, float(fan.group(1))) * 100 / 255, 1)
        elif upper.startswith("M107"):
            self.state["fan_percent"] = 0.0
        speed = re.search(r"(?:^|\s)S(\d+(?:\.\d+)?)", upper) if upper.startswith("M220") else None
        flow = re.search(r"(?:^|\s)S(\d+(?:\.\d+)?)", upper) if upper.startswith("M221") else None
        if speed:
            self.state["speed_percent"] = float(speed.group(1))
        if flow:
            self.state["flow_percent"] = float(flow.group(1))

    def control(self) -> str | None:
        try:
            mtime = self.control_path.stat().st_mtime
            if mtime <= self.last_control_mtime:
                return None
            self.last_control_mtime = mtime
            return json.loads(self.control_path.read_text(encoding="utf-8")).get("action")
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return None

    def peek_control(self) -> str | None:
        try:
            return json.loads(self.control_path.read_text(encoding="utf-8")).get("action")
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return None

    def wait_ok(self, timeout: float = 300) -> list[str]:
        assert self.printer is not None
        deadline = time.monotonic() + timeout
        lines: list[str] = []
        while time.monotonic() < deadline:
            if self.peek_control() == "stop":
                self.printer.write(b"M108\n")
                self.printer.flush()
                raise UserStopped()
            raw = self.printer.readline()
            if time.monotonic() - self.last_wait_update > 1:
                self.update()
                self.last_wait_update = time.monotonic()
            if not raw:
                continue
            text = raw.decode("utf-8", errors="replace").strip()
            if not text:
                continue
            lines.append(text)
            self.parse_temperature([text])
            low = text.lower()
            if low.startswith("ok"):
                return lines
            if "error:" in low or "thermal runaway" in low or "mintemp" in low or "maxtemp" in low:
                raise RuntimeError(text)
        raise TimeoutError("The printer stopped acknowledging USB commands.")

    def send(self, command: str, timeout: float = 300) -> list[str]:
        assert self.printer is not None
        if self.state.get("status") != "printing" or command.upper().startswith(("M105", "M109", "G80")):
            print(f"[{now()}] SEND {command}", flush=True)
        self.printer.write((command + "\n").encode("ascii", errors="strict"))
        self.printer.flush()
        responses = self.wait_ok(timeout)
        if command.upper().startswith(("M105", "M109", "G80")):
            for response in responses:
                print(f"[{now()}] RECV {response}", flush=True)
        return responses

    def connect(self) -> None:
        last_error: Exception | None = None
        for attempt in range(1, 7):
            resolved = find_prusa_port(self.port)
            if resolved:
                self.port = resolved
                self.state["port"] = resolved
            self.update(
                status="connecting",
                phase="connecting",
                message=f"Connecting to printer… attempt {attempt} of 6",
            )
            try:
                self.printer = serial.Serial(self.port, 115200, timeout=1, write_timeout=15)
                return
            except (serial.SerialException, FileNotFoundError) as exc:
                last_error = exc
                if attempt < 6:
                    time.sleep(2)
        raise RuntimeError(
            "The Prusa USB connection is unavailable. Reconnect the cable, wait for Windows to show the printer, then try again."
        ) from last_error

    def cooldown(self) -> None:
        if not self.printer or not self.printer.is_open:
            return
        for command in ("M108", "M104 S0", "M140 S0", "M107", "M84"):
            try:
                self.printer.write((command + "\n").encode("ascii"))
                self.printer.flush()
                time.sleep(0.12)
            except Exception:
                pass

    def ensure_nozzle_ready(self) -> None:
        """Block all extrusion until measured temperature is safely at target."""
        target = float(self.nozzle_temp)
        self.update(
            status="heating",
            phase="heating-nozzle",
            nozzle_interlock="locked",
            message=f"EXTRUSION LOCKED — waiting for nozzle to reach {self.nozzle_temp}°C.",
        )
        print(f"[{now()}] INTERLOCK locked; firmware wait for {self.nozzle_temp}C", flush=True)
        self.parse_temperature(self.send(f"M109 S{self.nozzle_temp}", 15 * 60))
        deadline = time.monotonic() + 15 * 60
        ready_samples = 0
        while time.monotonic() < deadline:
            self.parse_temperature(self.send("M105", 20))
            hotend = self.state.get("hotend")
            reported_target = self.state.get("hotend_target")
            if isinstance(reported_target, (int, float)) and reported_target < target - 1:
                raise RuntimeError("The printer did not hold the requested nozzle target. Print cancelled before extrusion.")
            if (
                isinstance(hotend, (int, float))
                and isinstance(reported_target, (int, float))
                and hotend >= target - 2
                and reported_target >= target - 1
            ):
                ready_samples += 1
            else:
                ready_samples = 0
            self.update(message=f"EXTRUSION LOCKED — nozzle {temp_value(hotend)} / {self.nozzle_temp}°C.")
            if ready_samples >= 2:
                print(f"[{now()}] INTERLOCK ready at {temp_value(hotend)}", flush=True)
                self.update(
                    phase="ready-to-extrude",
                    nozzle_interlock="ready",
                    message=f"Nozzle confirmed at {temp_value(hotend)}. Extrusion unlocked.",
                )
                return
            time.sleep(0.5)
        raise TimeoutError(f"Nozzle did not reach {self.nozzle_temp}°C. Print cancelled before extrusion.")

    def park_for_final_heat(self) -> None:
        """Lift away from the sheet and wait above the purge-line start."""
        self.update(
            status="heating",
            phase="parking-for-final-heat",
            nozzle_interlock="locked",
            message="Calibration done. Lifting and parking before final nozzle heat.",
        )
        print(f"[{now()}] PARK lift=10mm position=X0 Y-3", flush=True)
        for command in ("G91", "G1 Z10 F720", "G90", "G1 X0 Y-3 F3000"):
            self.send(command, 30)
        self.update(
            phase="parked-heating-nozzle",
            message=f"Parked 10 mm above purge area. Heating nozzle to {self.nozzle_temp}°C.",
        )

    def ensure_calibration_ready(self) -> None:
        """Require a fully heated bed and a stable 170 C nozzle before G80."""
        bed_target = self.calibration_bed_target
        self.update(
            status="heating",
            phase="calibration-preheat",
            nozzle_interlock="locked",
            message=f"Preparing calibration — nozzle 170°C, bed {bed_target:g}°C.",
        )
        print(f"[{now()}] CALIBRATION GUARD nozzle=170C bed={bed_target:g}C", flush=True)
        self.parse_temperature(self.send("M104 S170", 30))
        self.parse_temperature(self.send(f"M190 S{bed_target:g}", 15 * 60))
        self.parse_temperature(self.send("M109 S170", 15 * 60))
        ready_samples = 0
        deadline = time.monotonic() + 2 * 60
        while time.monotonic() < deadline:
            self.parse_temperature(self.send("M105", 20))
            hotend = self.state.get("hotend")
            hotend_target = self.state.get("hotend_target")
            bed = self.state.get("bed")
            reported_bed_target = self.state.get("bed_target")
            targets_held = (
                isinstance(hotend_target, (int, float))
                and hotend_target >= 169
                and isinstance(reported_bed_target, (int, float))
                and reported_bed_target >= bed_target - 1
            )
            temperatures_ready = (
                isinstance(hotend, (int, float))
                and hotend >= 168
                and isinstance(bed, (int, float))
                and bed >= bed_target - 1
            )
            if not targets_held:
                raise RuntimeError("The printer did not hold the calibration temperatures. Print cancelled before calibration.")
            ready_samples = ready_samples + 1 if temperatures_ready else 0
            self.update(message=f"Preparing calibration — nozzle {temp_value(hotend)} / 170°C, bed {temp_value(bed)} / {bed_target:g}°C.")
            if ready_samples >= 2:
                self.update(phase="calibrating", message="Temperatures confirmed. Running mesh calibration with extrusion locked.")
                return
            time.sleep(0.5)
        raise TimeoutError("Calibration temperatures could not be confirmed. Print cancelled.")

    def pause_loop(self) -> bool:
        self.update(status="paused", message="Paused. Heaters are still on.")
        last_temp = 0.0
        while True:
            action = self.control()
            if action == "resume":
                self.update(status="printing", message="Printing")
                return True
            if action == "stop":
                return False
            if time.monotonic() - last_temp > 3:
                self.parse_temperature(self.send("M105", 20))
                self.update()
                last_temp = time.monotonic()
            time.sleep(0.2)

    def run(self) -> None:
        ctypes.windll.kernel32.SetThreadExecutionState(0x80000001 | 0x00000002)
        try:
            print(f"[{now()}] KINO Print worker {WORKER_VERSION} starting: {self.gcode}", flush=True)
            self.update()
            self.connect()
            assert self.printer is not None
            time.sleep(2.5)
            self.printer.reset_input_buffer()
            identity = " | ".join(self.send("M115", 25))
            if "Prusa i3 MK3" not in identity:
                raise RuntimeError("The selected port did not identify as a Prusa i3 MK3/MK3S.")
            firmware = re.search(r"echo:\s*([0-9][^\s|]*)", identity)
            machine = re.search(r"MACHINE_TYPE:([^|]+?)(?:\s+EXTRUDER_COUNT:|\s*\|)", identity)
            self.state.update(
                firmware=firmware.group(1) if firmware else "Unknown",
                machine_type=machine.group(1).strip() if machine else "Prusa i3 MK3S",
            )
            sd_status = " | ".join(self.send("M27", 20)).lower()
            if "not sd printing" not in sd_status and "sd printing" in sd_status:
                raise RuntimeError("The printer is already running a job from its SD card.")

            self.update(status="heating", phase="warming-bed", message="Heating bed. Nozzle held at 170°C." if self.anti_ooze else "Heating bed and nozzle.")
            sent = 0
            last_report = 0.0
            last_telemetry = 0.0
            mesh_complete = False
            nozzle_ready = False
            current_layer = 0
            with self.gcode.open("r", encoding="utf-8", errors="replace") as source:
                for raw in source:
                    stripped = raw.strip()
                    if stripped == ";LAYER_CHANGE":
                        current_layer += 1
                        self.state["current_layer"] = current_layer
                    elif stripped.startswith(";Z:"):
                        try:
                            self.state["layer_z"] = float(stripped[3:])
                        except ValueError:
                            pass
                    command = raw.split(";", 1)[0].strip()
                    if not command:
                        continue
                    action = self.control()
                    if action == "stop":
                        self.update(status="stopping", message="Stopping. Heaters off.")
                        self.cooldown()
                        self.update(status="stopped", message="Print stopped. Heaters off.", progress=self.state.get("progress", 0))
                        return
                    if action == "pause" and not self.pause_loop():
                        self.update(status="stopping", message="Stopping. Heaters off.")
                        self.cooldown()
                        self.update(status="stopped", message="Print stopped. Heaters off.")
                        return

                    # A PrusaSlicer start sequence normally begins heating the
                    # nozzle before waiting for the much slower bed. PETG then
                    # sits molten and oozes during bed heat-up and probing.
                    # Hold at a non-printing 170 C until G80 has completed, then
                    # heat to the selected print temperature just in time.
                    target = 170 if self.anti_ooze and not mesh_complete else self.nozzle_temp
                    command = rewrite_nozzle_temperature(command, target)
                    self.parse_command_state(command)

                    extrusion_move = is_positive_extrusion(command)
                    if extrusion_move and not nozzle_ready:
                        self.ensure_nozzle_ready()
                        nozzle_ready = True
                    if extrusion_move and self.state["status"] != "printing":
                        self.update(status="printing", phase="printing", nozzle_interlock="ready", message="Printing")

                    if command.upper().startswith("G80"):
                        if self.anti_ooze:
                            self.ensure_calibration_ready()
                        self.update(phase="calibrating", nozzle_interlock="locked", message="Mesh calibration. Extrusion locked.")
                    responses = self.send(command)
                    self.parse_temperature(responses)
                    sent += 1
                    if self.anti_ooze and command.upper().startswith("G80"):
                        mesh_complete = True
                        self.park_for_final_heat()
                        self.ensure_nozzle_ready()
                        nozzle_ready = True
                    if time.monotonic() - last_telemetry > 5:
                        self.parse_temperature(self.send("M105", 20))
                        self.parse_temperature(self.send("M114", 20))
                        last_telemetry = time.monotonic()
                    if time.monotonic() - last_report > 1:
                        self.update(
                            commands_sent=sent,
                            progress=min(100.0, sent * 100 / max(1, self.info.command_count)),
                        )
                        last_report = time.monotonic()

            self.update(
                status="completed",
                phase="completed",
                message="Print completed",
                progress=100.0,
                commands_sent=sent,
                completed_at=now(),
            )
        except UserStopped:
            self.update(status="stopping", message="Stopping. Heaters off.")
            self.cooldown()
            self.update(status="stopped", phase="stopped", nozzle_interlock="locked", message="Print stopped. Heaters off.")
        except Exception as exc:
            self.cooldown()
            print(f"[{now()}] ERROR {type(exc).__name__}: {exc}", flush=True)
            message = (
                "USB disconnected during the print. Heater shutdown was attempted; verify both targets on the printer LCD."
                if isinstance(exc, serial.SerialException)
                else str(exc)
            )
            self.update(status="error", phase="error", nozzle_interlock="locked", message=message, error=type(exc).__name__)
            raise
        finally:
            if self.printer and self.printer.is_open:
                self.printer.close()
            ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", required=True)
    parser.add_argument("--file", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--control", required=True)
    parser.add_argument("--nozzle-temp", required=True, type=int)
    parser.add_argument("--anti-ooze", action="store_true")
    args = parser.parse_args()
    try:
        Worker(args.port, Path(args.file), Path(args.state), Path(args.control), args.nozzle_temp, args.anti_ooze).run()
        return 0
    except Exception:
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
