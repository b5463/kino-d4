"""Camera control bus on In2, north of the breakout headers (KiCad 10 python). ODD JOBS 87/88.

The expanders sit at the top edge: U600 (x 42-48) reads the four FAULT_N lines, U601 (x 65-71)
drives the four EN lines. The long runs between them and the far cameras never completed in the
grid router (its search window spans the board). In2 north of the header rows is empty, so the long
part of each line is drawn here as a straight In2 lane, with a via at each end placed in open space
a few mm from its pads; the grid router then makes only the short local connections.

    lane A  y 12.15   CAM1_FAULT_N  x ~28.6 - 40     CAM3_FAULT_N  x ~43 - 71
    lane B  y 12.80   CAM4_FAULT_N  x ~44 - 90
    lane C  y 13.45   CAM1_EN       x ~24 - 62       CAM4_EN       x ~76 - 88

Nominal ends; the add phase moves each end to the nearest via site clear on every layer (and of the
lanes already placed), so the exact x values are in outputs/A02-FIXED-ROUTES.json.

Camera 2 and 3 EN and camera 2 FAULT_N already route locally and are not on the bus. Clearances:
0.17 mm or more to every via, track and pad of another net; lanes are 0.65 mm apart so an end via
keeps 0.25 mm from the neighbouring lane. The CAM3_REQ and CAM4_REQ copper from the
last router pass (vias at y 11.7-12.7 on lanes A/B) and the EXP_RESET_N route (via at 53.7, 11.7 on
lane A) are removed for re-routing around the bus.
outputs/A02-FIXED-ROUTES.json records the lanes so rip_signals.py keeps them.
"""
import json
import pcbnew as pcb
from rework import ROOT, TARGET
from routing import pt

LANES = [  # net, y, x_from, x_to
    ('CAM1_FAULT_N', 12.15, 28.6, 40.0),
    ('CAM3_FAULT_N', 12.15, 43.0, 71.5),
    ('CAM4_FAULT_N', 12.80, 44.0, 93.2),
    ('CAM1_EN', 13.45, 22.6, 63.2),
    ('CAM4_EN', 13.45, 72.0, 87.7),
]
RIP = ('CAM3_REQ', 'CAM4_REQ', 'EXP_RESET_N')    # local expander nets re-routed around the bus

b = pcb.LoadBoard(str(TARGET))
tracks = list(b.GetTracks())                      # SWIG order trap: read before pad lists
mm = lambda v: pcb.ToMM(v) - 50
def on_lane(t, net, y, x0, x1):
    if t.GetNetname() != net: return False
    if isinstance(t, pcb.PCB_VIA):
        p = (mm(t.GetPosition().x), mm(t.GetPosition().y))
        return abs(p[1] - y) < 0.01 and (abs(p[0] - x0) < 0.01 or abs(p[0] - x1) < 0.01)
    s, e = (mm(t.GetStart().x), mm(t.GetStart().y)), (mm(t.GetEnd().x), mm(t.GetEnd().y))
    return t.GetLayer() == pcb.In2_Cu and abs(s[1] - y) < 0.01 and abs(e[1] - y) < 0.01
import sys
PHASE = sys.argv[1] if len(sys.argv) > 1 else ''
assert PHASE in ('remove', 'add', 'verify'), 'run three times: remove, add, verify (separate processes)'
# In this KiCad build a Remove() leaves the SWIG layer unreliable for the rest of the process: later
# FindNet() calls return untyped objects and an item added earlier was written out on another net.
# So removal, addition and the read-back check each run in their own process.
removed = 0
if PHASE == 'remove':
    doomed = [t for t in tracks if (not t.IsLocked() and t.GetNetname() in RIP)
              or any(on_lane(t, *lane) for lane in LANES)]         # re-running redraws the lanes
    removed = len(doomed)
    for t in doomed: b.Remove(t)
    pcb.SaveBoard(str(TARGET), b)
    print('camera bus: removed', removed, 'items (REQ3/REQ4 and any earlier lanes)', flush=True)
    import os; os._exit(0)
if PHASE == 'add':
    codes = {net: b.FindNet(net).GetNetCode() for net, *_ in LANES}
    pads = [q for f in b.GetFootprints() for q in f.Pads()]
    CLR, VIA_R = pcb.FromMM(0.17), pcb.FromMM(0.3)
    def P(x, y): return pcb.VECTOR2I(pcb.FromMM(50 + x), pcb.FromMM(50 + y))
    new_vias, new_lanes = [], []        # (centre, code) and (y, xa, xb, code) placed in this run
    def via_clear(x, y, code):
        c = P(x, y)
        for vc, vcode in new_vias:
            if vcode != code and (vc - c).EuclideanNorm() < 2 * VIA_R + CLR: return False
        for ly, la, lb, lcode in new_lanes:
            if lcode != code and pcb.SEG(P(la, ly), P(lb, ly)).Distance(c) < VIA_R + pcb.FromMM(0.1) + CLR: return False
        for t in tracks:
            if t.GetNetCode() == code: continue
            if isinstance(t, pcb.PCB_VIA):
                if (t.GetPosition() - c).EuclideanNorm() < VIA_R + t.GetWidth(pcb.F_Cu) // 2 + CLR: return False
            elif pcb.SEG(t.GetStart(), t.GetEnd()).Distance(c) < VIA_R + t.GetWidth() // 2 + CLR: return False
        for q in pads:
            if q.GetNetCode() == code and q.GetAttribute() != pcb.PAD_ATTRIB_NPTH: continue
            if (q.GetPosition() - c).EuclideanNorm() > pcb.FromMM(4): continue
            for layer in (pcb.F_Cu, pcb.In1_Cu, pcb.In2_Cu, pcb.B_Cu):
                if q.IsOnLayer(layer) and q.GetEffectiveShape(layer).Collide(c, VIA_R + CLR): return False
            if q.GetAttribute() != pcb.PAD_ATTRIB_SMD and (q.GetPosition() - c).EuclideanNorm() < q.GetDrillSize().x // 2 + VIA_R + pcb.FromMM(0.25): return False
        return True
    def lane_clear(y, xa, xb, code):
        seg = pcb.SHAPE_SEGMENT(P(xa, y), P(xb, y), pcb.FromMM(0.2))
        for vc, vcode in new_vias:
            if vcode != code and pcb.SEG(P(xa, y), P(xb, y)).Distance(vc) < VIA_R + pcb.FromMM(0.1) + CLR: return False
        for ly, la, lb, lcode in new_lanes:
            if lcode != code and abs(ly - y) < 0.4 and min(lb, xb) > max(la, xa): return False
        for t in tracks:
            if t.GetNetCode() == code: continue
            if isinstance(t, pcb.PCB_VIA):
                if seg.Collide(pcb.SHAPE_CIRCLE(t.GetPosition(), t.GetWidth(pcb.F_Cu) // 2), CLR): return False
            elif t.GetLayer() == pcb.In2_Cu and seg.Collide(pcb.SHAPE_SEGMENT(t.GetStart(), t.GetEnd(), t.GetWidth()), CLR): return False
        for q in pads:
            if q.GetNetCode() == code or not q.IsOnLayer(pcb.In2_Cu): continue
            if seg.Collide(q.GetEffectiveShape(pcb.In2_Cu), CLR): return False
        return True
    placed = []
    for i, (net, y, x0, x1) in enumerate(LANES):
        code = codes[net]
        def sites(x, inward):           # clear via x positions: inward up to 6 mm first, then outward up to 3 mm
            for k in range(0, 121):
                xx = round(x + inward * k * 0.05, 3)
                if via_clear(xx, y, code): yield xx
            for k in range(1, 61):
                xx = round(x - inward * k * 0.05, 3)
                if via_clear(xx, y, code): yield xx
        best = None
        for a_ in sites(x0, 1):
            for b2 in sites(x1, -1):
                if b2 - a_ > 2 and lane_clear(y, a_, b2, code): best = (a_, b2); break
            if best: break
        assert best, (net, 'no clear lane with clear end vias near', x0, x1)
        a_, b2 = best
        new_vias += [(P(a_, y), code), (P(b2, y), code)]; new_lanes.append((y, a_, b2, code))
        LANES[i] = (net, y, a_, b2); placed.append(f'{net} {a_}-{b2}')
    print('lane ends:', '; '.join(placed), flush=True)
    for net, y, x0, x1 in LANES:
        t = pcb.PCB_TRACK(b); t.SetStart(pt(50 + x0, 50 + y)); t.SetEnd(pt(50 + x1, 50 + y))
        t.SetWidth(pcb.FromMM(0.2)); t.SetLayer(pcb.In2_Cu); t.SetNetCode(codes[net]); t.SetLocked(True); b.Add(t)
        for x in (x0, x1):
            v = pcb.PCB_VIA(b); v.SetPosition(pt(50 + x, 50 + y)); v.SetWidth(pcb.FromMM(.6)); v.SetDrill(pcb.FromMM(.3))
            v.SetViaType(pcb.VIATYPE_THROUGH); v.SetLayerPair(pcb.F_Cu, pcb.B_Cu); v.SetNetCode(codes[net]); v.SetLocked(True); b.Add(v)
    pcb.SaveBoard(str(TARGET), b)
if PHASE == 'verify':
    rec = {r['net']: r['points'] for r in json.loads((ROOT / 'outputs/A02-FIXED-ROUTES.json').read_text())
           if r['layer'] == 'In2.Cu' and any(r['net'] == n and all(abs(p[1] - y) < 0.01 for p in r['points']) for n, y, *_ in LANES)}
    LANES = [(n, y, min(p[0] for p in rec[n]), max(p[0] for p in rec[n])) if n in rec else (n, y, x0, x1) for n, y, x0, x1 in LANES]
    found = {n: 0 for n, *_ in LANES}; bad = []
    for t in tracks:
        for net, y, x0, x1 in LANES:
            if isinstance(t, pcb.PCB_VIA):
                p = (mm(t.GetPosition().x), mm(t.GetPosition().y))
                hit = abs(p[1] - y) < 0.01 and min(abs(p[0] - x0), abs(p[0] - x1)) < 0.01
            else:
                hit = t.GetLayer() == pcb.In2_Cu and abs(mm(t.GetStart().y) - y) < 0.01 and abs(mm(t.GetEnd().y) - y) < 0.01 \
                      and abs(min(mm(t.GetStart().x), mm(t.GetEnd().x)) - x0) < 0.01
            if hit:
                found[net] += 1
                if t.GetNetname() != net: bad.append((net, t.GetNetname()))
    assert not bad and all(v == 3 for v in found.values()), ('lane check failed', bad, found)
    print('camera bus: verified', len(LANES), 'lanes, each 1 track + 2 vias on its own net', flush=True)
    import os; os._exit(0)

if PHASE != 'add': import os; os._exit(0)
path = ROOT / 'outputs/A02-FIXED-ROUTES.json'
fixed = [r for r in json.loads(path.read_text())
         if not any(r['net'] == n and r['layer'] == 'In2.Cu' and all(abs(p[1] - y) < 0.01 for p in r['points']) for n, y, _, _ in LANES)]
fixed += [{'net': n, 'layer': 'In2.Cu', 'width_mm': 0.2, 'points': [[x0, y], [x1, y]]} for n, y, x0, x1 in LANES]
path.write_text(json.dumps(fixed, indent=2) + '\n')
print('camera bus: added', len(LANES), 'lanes and', 2 * len(LANES), 'vias; fixed-route record updated', flush=True)
import os; os._exit(0)
