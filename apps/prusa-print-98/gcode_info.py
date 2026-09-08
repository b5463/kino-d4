from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from pathlib import Path


SETTING = re.compile(r"^;\s*([^=]+?)\s*=\s*(.*?)\s*$")
TIME = re.compile(r"estimated printing time \(normal mode\)\s*=\s*(.+)$", re.I)


@dataclass(frozen=True)
class GCodeInfo:
    path: str
    name: str
    size_bytes: int
    printer_model: str = "Unknown"
    printer_profile: str = "Unknown"
    filament_type: str = "Unknown"
    filament_grams: str = "Unknown"
    estimated_time: str = "Unknown"
    nozzle_temperature: str = "Unknown"
    bed_temperature: str = "Unknown"
    nozzle_diameter: str = "Unknown"
    command_count: int = 0
    total_layers: int = 0

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def inspect_gcode(path: str | Path) -> GCodeInfo:
    source = Path(path)
    if not source.is_file():
        raise FileNotFoundError(source)
    if source.suffix.lower() not in {".gcode", ".gco"}:
        raise ValueError("Please choose a sliced .gcode file.")

    values: dict[str, str] = {}
    estimated = "Unknown"
    commands = 0
    total_layers = 0
    with source.open("r", encoding="utf-8", errors="replace") as handle:
        for raw in handle:
            stripped = raw.strip()
            if stripped and not stripped.startswith(";"):
                commands += 1
            if stripped == ";LAYER_CHANGE":
                total_layers += 1
            match = SETTING.match(stripped)
            if match:
                values[match.group(1).strip()] = match.group(2).strip()
            time_match = TIME.search(stripped)
            if time_match:
                estimated = time_match.group(1).strip()

    return GCodeInfo(
        path=str(source.resolve()),
        name=source.name,
        size_bytes=source.stat().st_size,
        printer_model=values.get("printer_model", "Unknown"),
        printer_profile=values.get("printer_settings_id", "Unknown"),
        filament_type=values.get("filament_type", "Unknown"),
        filament_grams=values.get("total filament used [g]", values.get("filament used [g]", "Unknown")),
        estimated_time=estimated,
        nozzle_temperature=values.get("first_layer_temperature", values.get("temperature", "Unknown")),
        bed_temperature=values.get("first_layer_bed_temperature", values.get("bed_temperature", "Unknown")),
        nozzle_diameter=values.get("nozzle_diameter", "Unknown"),
        command_count=commands,
        total_layers=total_layers,
    )


def is_mk3s_job(info: GCodeInfo) -> bool:
    target = f"{info.printer_model} {info.printer_profile}".upper()
    return "MK3S" in target
