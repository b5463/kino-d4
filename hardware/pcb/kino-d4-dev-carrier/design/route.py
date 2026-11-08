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
# VBUS runs 0.6 mm: the USB-C pads are 0.6 mm wide at 0.8 mm pitch and a 1.0 mm track cannot enter them.
CLASSES = {'MainPower': (1000, ['VBUS_F', 'VBUS_M', '5V_IN', 'P4_5V']),
           'CameraPower': (600, ['VBUS'] + [f'CAM{n}_{s}' for n in range(1, 5) for s in ('SW5V', 'LINK', '5VJ', '5V')])}


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


def track(b, net, a, c, w, layer=pcb.B_Cu):
    t = pcb.PCB_TRACK(b)
    t.SetStart(pt(OFF + a[0], OFF + a[1])); t.SetEnd(pt(OFF + c[0], OFF + c[1]))
    t.SetWidth(pcb.FromMM(w)); t.SetLayer(layer); t.SetNet(b.GetNetInfo().GetNetItem(net))
    b.Add(t)


def export(work):
    work.mkdir(parents=True, exist_ok=True)
    b = pcb.LoadBoard(str(BOARD))
    # The USB-C VBUS pads come in two columns (x 106.6 and 111.4) with the CC pads between them;
    # Freerouting does not bridge them, so the bridge is laid here, under the pads, 0.6 mm, before
    # the DSN export: Freerouting keeps it as a fixed wire and routes the CC lines around it.
    for x in (106.6, 111.4):
        track(b, 'VBUS', (x, 61.53), (x, 60.0), .6)
    track(b, 'VBUS', (106.6, 60.0), (111.4, 60.0), .6)
    # ... and from the bridge up to the fuse, left of C1000 (Freerouting treats the fixed bridge as an obstacle).
    for a, c in (((106.6, 60.0), (105.1, 58.5)), ((105.1, 58.5), (105.1, 54.3)), ((105.1, 54.3), (106.86, 52.5))):
        track(b, 'VBUS', a, c, .6)
    pcb.SaveBoard(str(BOARD), b)
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
    if b.Zones():   # re-run: drop the old pours, then finish in a new process (the board object is unusable after Remove)
        for z in list(b.Zones()):
            b.Remove(z)
        pcb.SaveBoard(str(BOARD), b)
        subprocess.run([sys.executable, __file__, 'finish'], check=True)
        return
    # Freerouting leaves pad-width stubs inside the 0.3 mm USB-C pads; hold them to the 0.15 mm minimum.
    for t in b.GetTracks():
        if t.GetClass() == 'PCB_TRACK' and t.GetWidth() < pcb.FromMM(.15):
            t.SetWidth(pcb.FromMM(.15))
    # The ribbon header's ground pins sit between the UART tracks: a solid connection
    # instead of starved thermal spokes (hand-soldered 2.54 mm pins, 2-layer board).
    b.FindFootprintByReference('J100').SetLocalZoneConnection(pcb.ZONE_CONNECTION_FULL)
    # The edge LEDs sit in a strip of pour too narrow for two spokes; the socket GND pins are
    # hand-soldered 2.54 mm pins between the UART tracks, as the ribbon header's.
    # The USB-C shell and GND pads sit over the fixed VBUS bridge with no room for spokes either.
    for ref in ('D1000', 'D1001', 'D1002', 'J200', 'J300', 'J400', 'J500', 'J1000', 'U1002'):
        b.FindFootprintByReference(ref).SetLocalZoneConnection(pcb.ZONE_CONNECTION_FULL)
    twins = twin_vias(b)
    pours(b)
    stitched = stitch(b)
    tracks = sum(1 for t in b.GetTracks() if t.GetClass() == 'PCB_TRACK')
    vias = sum(1 for t in b.GetTracks() if t.GetClass() == 'PCB_VIA')
    pcb.SaveBoard(str(BOARD), b)
    print({'tracks': tracks, 'vias': vias, 'zones': len(b.Zones()), 'twin_vias': twins, 'stitching_vias': stitched})


POWER_NETS = {'5V_IN', 'P4_5V', 'VBUS_F', 'VBUS_M', 'VBUS'} | {f'CAM{n}_{s}' for n in range(1, 5) for s in ('SW5V', 'LINK', '5VJ', '5V')}


def twin_vias(b):
    """A 0.3 mm drill carries about what a 0.7 mm 1 oz track does; a power net must not change layers
    through one. For every via on a power net, add a second one beside it where the copper allows
    (0.15 mm clearance to other nets, 0.25 mm hole to hole, 0.5 mm to the edge). Returns the count."""
    from placement import WIDTH, HEIGHT
    tracks = [t for t in b.GetTracks() if t.GetClass() == 'PCB_TRACK']
    vias = [t for t in b.GetTracks() if t.GetClass() == 'PCB_VIA']
    pads = [(p, p.GetBoundingBox()) for fp in b.GetFootprints() for p in fp.Pads()]
    clr, r = pcb.FromMM(.25), pcb.FromMM(.3)   # 0.15 rule plus margin for the 0.2 mm path sampling

    def clear(p, net, ignore=()):
        if not (pcb.FromMM(OFF + .9) < p.x < pcb.FromMM(OFF + WIDTH - .9) and pcb.FromMM(OFF + .9) < p.y < pcb.FromMM(OFF + HEIGHT - .9)):
            return False
        for t in tracks:
            if t.GetNetname() != net and pcb.SEG(t.GetStart(), t.GetEnd()).Distance(p) < r + t.GetWidth() // 2 + clr:
                return False
        for v in vias:
            if v in ignore:
                continue
            if (v.GetPosition() - p).EuclideanNorm() < (r + r + clr if v.GetNetname() != net else pcb.FromMM(.75)):
                return False
        for pad, bb in pads:
            box = pcb.BOX2I(bb.GetOrigin(), bb.GetSize()); box.Inflate(r + clr + (0 if pad.GetNetname() == net else pcb.FromMM(.1)))
            if box.Contains(p):
                return False
        return True

    def path_clear(v, p):
        """The joining track, 0.6 mm wide on both layers: sample it every 0.2 mm, ignoring the via it starts from."""
        a, net = v.GetPosition(), v.GetNetname()
        n = max(2, int((p - a).EuclideanNorm() / pcb.FromMM(.2)))
        return all(clear(pcb.VECTOR2I(a.x + (p.x - a.x) * i // n, a.y + (p.y - a.y) * i // n), net, (v,)) for i in range(1, n))

    added = 0
    offsets = [(d * c, d * s) for d in (1.0, 1.4, 1.8, 2.2, 2.6, 3.0) for c, s in ((1, 0), (-1, 0), (0, 1), (0, -1), (.71, .71), (-.71, .71), (.71, -.71), (-.71, -.71))]
    for v in [v for v in vias if v.GetNetname() in POWER_NETS]:
        a, net = v.GetPosition(), v.GetNetname()
        if any(o is not v and o.GetNetname() == net and (o.GetPosition() - a).EuclideanNorm() <= pcb.FromMM(2.5) for o in vias):
            continue   # already paired (a re-run of finish)
        for dx, dy in offsets:
            p = pcb.VECTOR2I(a.x + pcb.FromMM(dx), a.y + pcb.FromMM(dy))
            if clear(p, net) and path_clear(v, p):
                t = pcb.PCB_VIA(b)
                t.SetViaType(pcb.VIATYPE_THROUGH); t.SetPosition(p); t.SetWidth(pcb.FromMM(.6)); t.SetDrill(pcb.FromMM(.3))
                t.SetLayerPair(pcb.F_Cu, pcb.B_Cu); t.SetNet(v.GetNet())
                b.Add(t); vias.append(t); added += 1
                for layer in (pcb.F_Cu, pcb.B_Cu):   # the pair is one via electrically only once copper joins it
                    s = pcb.PCB_TRACK(b); s.SetStart(a); s.SetEnd(p); s.SetWidth(pcb.FromMM(.6)); s.SetLayer(layer); s.SetNet(v.GetNet())
                    b.Add(s); tracks.append(s)
                break
        else:
            print('no room for a twin via on', v.GetNetname(), 'at', round(v.GetPosition().x / 1e6 - OFF, 2), round(v.GetPosition().y / 1e6 - OFF, 2))
    return added


def stitch(b):
    """Tracks can cut a GND pour into islands. For every island of the back pour beyond the largest,
    drop a GND via at a point that sits inside both pours with room for the via and its clearance,
    then refill. Returns the number of vias added."""
    zones = {z.GetZoneName(): z for z in b.Zones()}
    back, front = zones['GND back'].GetFilledPolysList(pcb.B_Cu), zones['GND front'].GetFilledPolysList(pcb.F_Cu)
    if back.OutlineCount() <= 1:
        return 0
    main = max(range(back.OutlineCount()), key=lambda i: back.Outline(i).Area())
    room = pcb.FromMM(.65)   # 0.3 via radius + 0.3 clearance + margin
    added = 0
    for i in range(back.OutlineCount()):
        if i == main:
            continue
        bb = back.Outline(i).BBox()
        step = pcb.FromMM(.5)
        hit = None
        y = bb.GetTop() + room
        while y < bb.GetBottom() - room and hit is None:
            x = bb.GetLeft() + room
            while x < bb.GetRight() - room:
                p = pcb.VECTOR2I(x, y)
                if back.Contains(p, i) and back.Outline(i).Distance(p) >= room and front.Contains(p) and \
                        min(front.Outline(k).Distance(p) for k in range(front.OutlineCount()) if front.Contains(p, k)) >= room:
                    hit = p
                    break
                x += step
            y += step
        if hit is None:
            print('no room for a stitching via in back island', i)
            continue
        v = pcb.PCB_VIA(b)
        v.SetViaType(pcb.VIATYPE_THROUGH); v.SetPosition(hit)
        v.SetWidth(pcb.FromMM(.6)); v.SetDrill(pcb.FromMM(.3))
        v.SetLayerPair(pcb.F_Cu, pcb.B_Cu); v.SetNet(b.GetNetInfo().GetNetItem('GND'))
        b.Add(v); added += 1
    if added:
        pcb.ZONE_FILLER(b).Fill(b.Zones())
    return added


if __name__ == '__main__':
    {'export': export, 'import': import_, 'finish': finish}[sys.argv[1]](Path(sys.argv[2]) if len(sys.argv) > 2 else None)
