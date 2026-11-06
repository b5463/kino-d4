"""Route the dev carrier D1 with Freerouting, then pour the ground planes.

  python route.py export WORK   - write WORK/d1.dsn from the placed board
  (run Freerouting on it: see README.md)
  python route.py import WORK   - read WORK/d1.ses, add the GND pours on both faces, fill, save

Run with KiCad 10's bundled python.exe.
"""
import re
import subprocess
import sys
from pathlib import Path
import pcbnew as pcb

ROOT = Path(__file__).resolve().parent.parent
BOARD = ROOT / 'KINO_D4_Dev_Carrier_D1.kicad_pcb'
OFF = 50.0


def pt(x, y): return pcb.VECTOR2I(round(x * 1e6), round(y * 1e6))


# The DSN exporter writes one class with the default width, whatever the project's
# netclass patterns say, so the power classes are written into the DSN here.
CLASSES = {'MainPower': (1000, ['5V_IN', 'P4_5V']),
           'CameraPower': (600, [f'CAM{n}_{s}' for n in range(1, 5) for s in ('SW5V', 'LINK', '5V')])}


def classes(dsn):
    m = re.search(r'\(class kicad_default (.*?)\n(\s*\(circuit.*?\n\s*\)\n\s*\(rule.*?\n\s*\)\n)', dsn, re.S)
    assert m, 'kicad_default class block not found'
    nets, body = m.group(1).split(), m.group(2)
    extra = ''
    for name, (width, members) in CLASSES.items():
        assert set(members) <= set(nets), (name, set(members) - set(nets))
        nets = [n for n in nets if n not in members]
        extra += f'    (class {name} {" ".join(members)}\n' + re.sub(r'\(width [\d.]+\)', f'(width {width})', body) + '    )\n'
    start, end = m.span(1)
    out = dsn[:start] + ' '.join(nets) + dsn[end:]
    i = out.index('\n    )\n', m.start()) + len('\n    )\n')
    return out[:i] + extra + out[i:]


def export(work):
    work.mkdir(parents=True, exist_ok=True)
    b = pcb.LoadBoard(str(BOARD))
    path = work / 'd1.dsn'
    assert pcb.ExportSpecctraDSN(b, str(path)), 'DSN export failed'
    path.write_text(classes(path.read_text(encoding='utf-8')), encoding='utf-8')
    print('wrote', path)


def pours(b):
    from placement import WIDTH, HEIGHT
    gnd = b.GetNetInfo().GetNetItem('GND')
    for layer in (pcb.F_Cu, pcb.B_Cu):
        z = pcb.ZONE(b)
        z.SetNet(gnd)
        z.SetLayer(layer)
        z.SetLocalClearance(pcb.FromMM(.3))
        z.SetMinThickness(pcb.FromMM(.25))
        z.SetPadConnection(pcb.ZONE_CONNECTION_THERMAL)
        z.SetThermalReliefGap(pcb.FromMM(.3))
        z.SetThermalReliefSpokeWidth(pcb.FromMM(.4))
        z.SetIslandRemovalMode(pcb.ISLAND_REMOVAL_MODE_ALWAYS)
        z.SetZoneName(f'GND {"front" if layer == pcb.F_Cu else "back"}')
        o = z.Outline()
        o.NewOutline()
        m = .5   # inside the 0.5 mm copper-to-edge rule
        for x, y in ((m, m), (WIDTH - m, m), (WIDTH - m, HEIGHT - m), (m, HEIGHT - m)):
            o.Append(pt(OFF + x, OFF + y))
        b.Add(z)
    pcb.ZONE_FILLER(b).Fill(b.Zones())


def import_(work):
    b = pcb.LoadBoard(str(BOARD))
    for z in list(b.Zones()):
        b.Remove(z)
    assert pcb.ImportSpecctraSES(b, str(work / 'd1.ses')), 'SES import failed'
    pcb.SaveBoard(str(BOARD), b)
    # The board object is unusable after the SES import in this API: finish in a new process.
    subprocess.run([sys.executable, __file__, 'finish'], check=True)


def finish(_=None):
    b = pcb.LoadBoard(str(BOARD))
    # Freerouting leaves pad-width stubs inside the 0.3 mm USB-C pads; hold them to the 0.15 mm minimum.
    for t in b.GetTracks():
        if t.GetClass() == 'PCB_TRACK' and t.GetWidth() < pcb.FromMM(.15):
            t.SetWidth(pcb.FromMM(.15))
    # The ribbon header's ground pins sit between the UART tracks: a solid connection
    # instead of starved thermal spokes (hand-soldered 2.54 mm pins, 2-layer board).
    b.FindFootprintByReference('J100').SetLocalZoneConnection(pcb.ZONE_CONNECTION_FULL)
    # The edge LEDs sit in a strip of pour too narrow for two spokes.
    for ref in ('D1000', 'D1001', 'D1002'):
        b.FindFootprintByReference(ref).SetLocalZoneConnection(pcb.ZONE_CONNECTION_FULL)
    pours(b)
    tracks = sum(1 for t in b.GetTracks() if t.GetClass() == 'PCB_TRACK')
    vias = sum(1 for t in b.GetTracks() if t.GetClass() == 'PCB_VIA')
    pcb.SaveBoard(str(BOARD), b)
    print({'tracks': tracks, 'vias': vias, 'zones': len(b.Zones())})


if __name__ == '__main__':
    {'export': export, 'import': import_, 'finish': finish}[sys.argv[1]](Path(sys.argv[2]) if len(sys.argv) > 2 else None)
