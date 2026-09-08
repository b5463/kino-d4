import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gcode_info import inspect_gcode, is_mk3s_job
from bridge import cooldown, diagnose
from print_worker import Worker, find_prusa_port, is_positive_extrusion, rewrite_nozzle_temperature


class GCodeInfoTests(unittest.TestCase):
    def test_emergency_cooldown_confirms_zero_targets(self):
        class Port:
            device = "COM11"
            description = "Original Prusa i3 MK3"
            vid = 0x2C99

        class FakePrinter:
            def __init__(self, *_args, **_kwargs):
                self.commands = []
                self.responses = []

            def write(self, payload):
                command = payload.decode("ascii").strip()
                self.commands.append(command)
                if command == "M105":
                    self.responses.append(b"ok T:180.0 /0.0 B:60.0 /0.0 @:0 B@:0\n")

            def flush(self):
                pass

            def reset_input_buffer(self):
                self.responses.clear()

            def readline(self):
                return self.responses.pop(0) if self.responses else b""

            def close(self):
                pass

        fake = FakePrinter()
        with patch("bridge.list_ports.comports", return_value=[Port()]), patch("bridge.serial.Serial", return_value=fake), patch("bridge.time.sleep", return_value=None):
            result = cooldown("COM11")
        self.assertTrue(result["ok"])
        self.assertEqual(fake.commands, ["M108", "M104 S0", "M140 S0", "M107", "M84", "M105"])

    def test_prusa_port_follows_device_when_com_number_changes(self):
        class Port:
            def __init__(self, device, description, vid):
                self.device = device
                self.description = description
                self.vid = vid

        ports = [Port("COM4", "Other device", 1), Port("COM12", "Original Prusa i3 MK3", 0x2C99)]
        with patch("print_worker.list_ports.comports", return_value=ports):
            self.assertEqual(find_prusa_port("COM11"), "COM12")

    def test_temperature_override_preserves_shutdown(self):
        self.assertEqual(rewrite_nozzle_temperature("M104 S240", 170), "M104 S170")
        self.assertEqual(rewrite_nozzle_temperature("M109 R240", 170), "M109 R240")
        self.assertEqual(rewrite_nozzle_temperature("M104 S0", 230), "M104 S0")

    def test_detects_positive_extrusion_moves(self):
        self.assertTrue(is_positive_extrusion("G1 X60 E9 F1000"))
        self.assertTrue(is_positive_extrusion("G1 E0.25 F300"))
        self.assertFalse(is_positive_extrusion("G1 E-1 F2100"))
        self.assertFalse(is_positive_extrusion("G1 X60 Y20 F1000"))

    def test_nozzle_gate_waits_for_two_hot_samples(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            gcode = root / "part.gcode"
            gcode.write_text("G1 E1\n", encoding="utf-8")
            worker = Worker("COM1", gcode, root / "state.json", root / "control.json", 230, True)
            replies = iter([
                ["ok"],
                ["ok T:170.0 /230.0 B:85.0 /85.0 @:127 B@:0"],
                ["ok T:228.2 /230.0 B:85.0 /85.0 @:64 B@:0"],
                ["ok T:229.1 /230.0 B:85.0 /85.0 @:32 B@:0"],
            ])
            sent = []

            def fake_send(command, _timeout=300):
                sent.append(command)
                return next(replies)

            worker.send = fake_send
            with patch("print_worker.time.sleep", return_value=None):
                worker.ensure_nozzle_ready()
            self.assertEqual(sent, ["M109 S230", "M105", "M105", "M105"])
            self.assertEqual(worker.state["hotend"], 229.1)

    def test_nozzle_gate_cancels_if_printer_clears_target(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            gcode = root / "part.gcode"
            gcode.write_text("G1 E1\n", encoding="utf-8")
            worker = Worker("COM1", gcode, root / "state.json", root / "control.json", 230, True)
            replies = iter([
                ["ok"],
                ["ok T:169.0 /0.0 B:85.0 /85.0 @:0 B@:0"],
            ])
            worker.send = lambda _command, _timeout=300: next(replies)
            with patch("print_worker.time.sleep", return_value=None):
                with self.assertRaisesRegex(RuntimeError, "did not hold the requested nozzle target"):
                    worker.ensure_nozzle_ready()

    def test_full_startup_sends_no_post_calibration_move_before_heat_gate(self):
        class FakePrinter:
            def __init__(self):
                self.commands = []
                self.responses = []
                self.is_open = True

            def write(self, payload):
                command = payload.decode("ascii").strip()
                self.commands.append(command)
                if command == "M115":
                    lines = ["echo:3.14.1 MACHINE_TYPE:Prusa i3 MK3 EXTRUDER_COUNT:1", "ok"]
                elif command == "M27":
                    lines = ["Not SD printing", "ok"]
                elif command == "M105":
                    hot = 229.2 if "M109 S230" in self.commands else 170.0
                    target = 230.0 if "M109 S230" in self.commands else 170.0
                    lines = [f"T:{hot} /{target} B:85.0 /85.0 @:32 B@:0", "ok"]
                elif command == "M114":
                    lines = ["X:0.00 Y:0.00 Z:0.00 E:0.00", "ok"]
                elif command == "M109 S230":
                    lines = ["T:229.0 /230.0 B:85.0 /85.0 @:64 B@:0", "ok"]
                else:
                    lines = ["ok"]
                self.responses.extend(f"{line}\n".encode("ascii") for line in lines)

            def flush(self):
                pass

            def readline(self):
                return self.responses.pop(0) if self.responses else b""

            def reset_input_buffer(self):
                self.responses.clear()

            def close(self):
                self.is_open = False

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            gcode = root / "part.gcode"
            gcode.write_text(
                "M104 S240\nM140 S85\nM190 S85\nM109 S240\nG28 W\nG80\n"
                "G1 Z0.2 F720\nG1 X60 E9 F1000\n"
                "; filament_type = PETG\n; printer_model = MK3S\n"
                "; printer_settings_id = Original Prusa i3 MK3S\n",
                encoding="utf-8",
            )
            fake = FakePrinter()
            worker = Worker("COM1", gcode, root / "state.json", root / "control.json", 230, True)
            with patch("print_worker.serial.Serial", return_value=fake), patch("print_worker.time.sleep", return_value=None):
                worker.run()
            calibration = fake.commands.index("G80")
            heat_gate = fake.commands.index("M109 S230")
            relative_mode = fake.commands.index("G91", calibration + 1)
            safe_lift = fake.commands.index("G1 Z10 F720")
            absolute_mode = fake.commands.index("G90", relative_mode + 1)
            purge_park = fake.commands.index("G1 X0 Y-3 F3000")
            calibration_bed_wait = max(index for index, command in enumerate(fake.commands) if command == "M190 S85")
            calibration_nozzle_wait = max(index for index, command in enumerate(fake.commands) if command == "M109 S170")
            first_post_calibration_move = fake.commands.index("G1 Z0.2 F720")
            first_extrusion = fake.commands.index("G1 X60 E9 F1000")
            self.assertLess(calibration_bed_wait, calibration)
            self.assertLess(calibration_nozzle_wait, calibration)
            self.assertLess(calibration, relative_mode)
            self.assertLess(relative_mode, safe_lift)
            self.assertLess(safe_lift, absolute_mode)
            self.assertLess(absolute_mode, purge_park)
            self.assertLess(purge_park, heat_gate)
            self.assertLess(heat_gate, first_post_calibration_move)
            self.assertLess(heat_gate, first_extrusion)

    def test_detects_ooze_prone_start_sequence(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "petg.gcode"
            path.write_text(
                "M104 S240\nM140 S85\nM190 S85\nM109 S240\nG28 W\nG80\n"
                "; filament_type = PETG\n; first_layer_temperature = 240\n"
                "; printer_model = MK3S\n; printer_settings_id = Original Prusa i3 MK3S\n",
                encoding="utf-8",
            )
            result = diagnose(str(path))
            issue_ids = {issue["id"] for issue in result["issues"]}
            self.assertEqual(result["recommendedNozzle"], 230)
            self.assertTrue(result["recommendedAntiOoze"])
            self.assertIn("early-hotend", issue_ids)
            self.assertIn("hot-probing", issue_ids)
            self.assertIn("hot-petg", issue_ids)

    def test_extracts_prusaslicer_metadata_and_commands(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "part.gcode"
            path.write_text(
                "; generated by PrusaSlicer\n"
                ";LAYER_CHANGE\n;Z:0.2\n"
                "M862.3 P \"MK3S\"\n"
                ";LAYER_CHANGE\n;Z:0.4\n"
                "G28 W\n"
                "; estimated printing time (normal mode) = 1h 2m\n"
                "; filament used [g] = 12.50\n"
                "; filament_type = PETG\n"
                "; first_layer_temperature = 240\n"
                "; first_layer_bed_temperature = 85\n"
                "; nozzle_diameter = 0.4\n"
                "; printer_model = MK3S\n"
                "; printer_settings_id = Original Prusa i3 MK3S & MK3S+\n",
                encoding="utf-8",
            )
            info = inspect_gcode(path)
            self.assertEqual(info.command_count, 2)
            self.assertEqual(info.total_layers, 2)
            self.assertEqual(info.filament_type, "PETG")
            self.assertEqual(info.estimated_time, "1h 2m")
            self.assertTrue(is_mk3s_job(info))

    def test_parses_live_printer_telemetry(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            gcode = root / "part.gcode"
            gcode.write_text("G28\n", encoding="utf-8")
            worker = Worker("COM1", gcode, root / "state.json", root / "control.json", 230, True)
            worker.parse_temperature([
                "ok T:229.7 /230.0 B:84.9 /85.0 @:64 B@:127",
                "X:10.00 Y:20.00 Z:0.35 E:4.00 Count X:0 Y:0 Z:0",
            ])
            worker.parse_command_state("M73 P42 R123")
            worker.parse_command_state("M106 S127.5")
            worker.parse_command_state("M220 S95")
            worker.parse_command_state("M221 S98")
            self.assertEqual(worker.state["hotend"], 229.7)
            self.assertEqual(worker.state["hotend_power"], 64.0)
            self.assertEqual(worker.state["position_z"], 0.35)
            self.assertEqual(worker.state["remaining_minutes"], 123)
            self.assertEqual(worker.state["firmware_progress"], 42)
            self.assertEqual(worker.state["fan_percent"], 50.0)
            self.assertEqual(worker.state["speed_percent"], 95.0)
            self.assertEqual(worker.state["flow_percent"], 98.0)


if __name__ == "__main__":
    unittest.main()
