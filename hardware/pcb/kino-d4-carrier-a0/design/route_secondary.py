"""Secondary routing after the explicit power routes: export for Freerouting, then import.

    python route_secondary.py export   -> .cache/carrier-routing/a02-secondary.dsn
    python route_secondary.py import   <- .cache/carrier-routing/a02-secondary.ses

Every existing track and via is exported as protected, so the router cannot move the
hand-routed power paths. In1 stays a ground plane. Class widths for this pass:
SYS_5V 1.0 mm (camera trunk, ~2.6 A); remaining MainPower connections are sense taps
(test pads, feedback, gate bias, gauge pins) at 0.4 mm; camera power 0.6 mm; MB_3V3 0.3 mm.
Autorouter output is a draft: every net class is reviewed afterwards (ODD JOBS 191).
"""
import re, sys
import pcbnew as pcb
from rework import TARGET
from routing import CACHE, restore_through_hole_mask

DSN, SES = CACHE / 'a02-secondary.dsn', CACHE / 'a02-secondary.ses'

def export():
    b = pcb.LoadBoard(str(TARGET))
    for t in list(b.GetTracks()): t.SetLocked(True)          # in memory only; the board file is not saved
    pcb.ExportSpecctraDSN(b, str(DSN))
    text = DSN.read_text()
    text = text.replace('(layer In1.Cu\n      (type signal)', '(layer In1.Cu\n      (type power)', 1)
    settings = '''(autoroute_settings
      (autoroute on) (postroute on) (vias on)
      (via_costs 60) (plane_via_costs 10) (start_ripup_costs 100)
      (layer_rule F.Cu (active on) (preferred_direction horizontal)
        (preferred_direction_trace_costs 1.0) (against_preferred_direction_trace_costs 2.5))
      (layer_rule In1.Cu (active off) (preferred_direction horizontal)
        (preferred_direction_trace_costs 99.0) (against_preferred_direction_trace_costs 99.0))
      (layer_rule In2.Cu (active on) (preferred_direction vertical)
        (preferred_direction_trace_costs 1.5) (against_preferred_direction_trace_costs 3.0))
      (layer_rule B.Cu (active on) (preferred_direction vertical)
        (preferred_direction_trace_costs 1.0) (against_preferred_direction_trace_costs 2.0)))'''
    text = text.replace('(boundary', settings + '\n    (boundary', 1)
    # SYS_5V leaves MainPower for its own 1.0 mm class; MainPower remainder routes as sense taps.
    m = re.search(r'\(class MainPower ([^()]*)', text)
    assert m and 'SYS_5V' in m.group(1).split(), 'MainPower class not found as expected'
    nets = [n for n in m.group(1).split() if n != 'SYS_5V']
    text = text.replace(m.group(0), '(class MainPower ' + ' '.join(nets) + '\n      ', 1)
    text = re.sub(r'(\(class MainPower[^)]*?\(circuit[^)]*\)\s*\)\s*\(rule\s*\(width )1200', r'\g<1>400', text, count=1)
    trunk = '''    (class Trunk5V SYS_5V
      (circuit (use_via "Via[0-3]_600:300_um"))
      (rule (width 1000) (clearance 200))
    )
'''
    text = text.replace('    (class MainPower', trunk + '    (class MainPower', 1)
    assert '(width 400)' in text and 'class Trunk5V' in text
    # Outer GND pours export as full-board planes, which Freerouting treats as obstacles on signal
    # layers: every non-GND pin is walled in ("no accessible expansion doors"). Drop them; the pours
    # are refilled after import. GND moves to its own class, which the router is told to ignore
    # (--router.ignore_net_classes=GroundNet), so it does not route ground the pours will carry.
    text, n = re.subn(r'\(plane GND \(polygon [FB]\.Cu [^)]*\)\)\s*', '', text)
    assert n == 2, f'expected two outer GND planes, removed {n}'
    m = re.search(r'\(class kicad_default ([^()]*)', text)
    assert m and 'GND' in m.group(1).split()
    rest = [n for n in m.group(1).split() if n != 'GND']
    text = text.replace(m.group(0), '(class kicad_default ' + ' '.join(rest) + '\n      ', 1)
    ground = '''    (class GroundNet GND
      (circuit (use_via "Via[0-3]_600:300_um"))
      (rule (width 300) (clearance 150))
    )
'''
    text = text.replace('    (class Trunk5V', ground + '    (class Trunk5V', 1)
    DSN.write_text(text)
    print('exported', DSN)

def import_route():
    b = pcb.LoadBoard(str(TARGET))
    assert pcb.ImportSpecctraSES(b, str(SES))
    assert not any(t.GetLayer() == pcb.In1_Cu for t in b.GetTracks() if not isinstance(t, pcb.PCB_VIA)), \
        'router used the reserved ground layer'
    for t in list(b.GetTracks()): t.SetLocked(False)
    restore_through_hole_mask(b); pcb.SaveBoard(str(TARGET), b)
    print('imported', SES)

if __name__ == '__main__':
    {'export': export, 'import': import_route}[sys.argv[1]]()
