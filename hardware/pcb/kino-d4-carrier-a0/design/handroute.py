"""Shared rip / add phases for the A0.2 hand-route scripts (KiCad 10 python).

A script lists RIP items (net, layer 'F'/'B'/'I2' or 'V', a, b): a track by both ends, a via by its
position (b None), and ADD items (net, layer or 'V', width, points): a polyline or one via. Every
added item is locked and every track segment must be 0 or 45 degrees. 'rip' removes each RIP item,
which must match exactly one item on the board (a layer written 'B*' etc. takes every duplicate);
'place' (when the script passes PLACE, {ref: ((x, y), rotation, 'F'/'B')}, or PAD_NETS, {(ref, pad):
net} for a pin map changed in circuit.py) moves footprints and sets pad nets; 'run'
dispatches on argv[1] and runs one phase in its own process (a Remove() leaves this KiCad build's
bindings unreliable for the rest of a run): rip, place, add in that order.
rip_nets entries (net, (x0, y0, x1, y1)) also rip every unlocked item of that net lying wholly in the box.
"""
import os, sys
import pcbnew as pcb
from rework import TARGET
from routing import pt

LAY = {'F': pcb.F_Cu, 'B': pcb.B_Cu, 'I2': pcb.In2_Cu}
mm = lambda v: pcb.ToMM(v) - 50
near = lambda p, q, e=0.02: abs(mm(p.x) - q[0]) < e and abs(mm(p.y) - q[1]) < e


def _rip(b, rip, rip_nets=()):
    tracks = list(b.GetTracks())
    doomed, missing = [], []
    for net, layer, a, c in rip:
        dup = layer.endswith('*'); layer = layer.rstrip('*')
        hit = [t for t in tracks if t.GetNetname() == net and (
            (layer == 'V' and isinstance(t, pcb.PCB_VIA) and near(t.GetPosition(), a)) or
            (layer != 'V' and not isinstance(t, pcb.PCB_VIA) and t.GetLayer() == LAY[layer] and
             ((near(t.GetStart(), a) and near(t.GetEnd(), c)) or (near(t.GetStart(), c) and near(t.GetEnd(), a)))))]
        if len(hit) != 1 and not (dup and hit): missing.append((net, layer, a, c, len(hit)))
        doomed += hit
    assert not missing, ('rip targets not found exactly once', missing)
    for net, box in rip_nets:                        # (net, (x0, y0, x1, y1)): unlocked copper inside a box
        x0, y0, x1, y1 = box
        inside = lambda p: x0 <= mm(p.x) <= x1 and y0 <= mm(p.y) <= y1
        for t in tracks:
            if t.GetNetname() != net or t.IsLocked() or any(t is d for d in doomed): continue
            ends = (t.GetPosition(),) if isinstance(t, pcb.PCB_VIA) else (t.GetStart(), t.GetEnd())
            if all(inside(e) for e in ends): doomed.append(t)
    k = len(doomed)
    for t in doomed: b.Remove(t)                     # last: Remove() invalidates the other proxies
    return k


def _add(b, add):
    n = 0
    for net, layer, w, pts in add:
        code = b.FindNet(net).GetNetCode()
        if layer == 'V':
            v = pcb.PCB_VIA(b); v.SetPosition(pt(50 + pts[0][0], 50 + pts[0][1])); v.SetWidth(pcb.FromMM(.6)); v.SetDrill(pcb.FromMM(.3))
            v.SetViaType(pcb.VIATYPE_THROUGH); v.SetLayerPair(pcb.F_Cu, pcb.B_Cu); v.SetNetCode(code); v.SetLocked(True); b.Add(v); n += 1
            continue
        for a, c in zip(pts, pts[1:]):
            dx, dy = abs(c[0] - a[0]), abs(c[1] - a[1])
            assert min(dx, dy) < 1e-6 or abs(dx - dy) < 2e-3, (net, 'non-45', a, c)
            t = pcb.PCB_TRACK(b); t.SetStart(pt(50 + a[0], 50 + a[1])); t.SetEnd(pt(50 + c[0], 50 + c[1]))
            t.SetWidth(pcb.FromMM(w)); t.SetLayer(LAY[layer]); t.SetNetCode(code); t.SetLocked(True); b.Add(t); n += 1
    return n


def _pad_nets(b, pad_nets):
    fs = {f.GetReference(): f for f in b.GetFootprints()}
    out = []
    for (ref, num), net in pad_nets.items():
        pad = next(p for p in fs[ref].Pads() if p.GetNumber() == num)
        code = b.FindNet(net).GetNetCode(); old = pad.GetNetname()
        pad.SetNetCode(code); out.append(f'{ref}.{num} {old}->{net}')
    return ', '.join(out)


def _place(b, place):
    fs = {f.GetReference(): f for f in b.GetFootprints()}
    flip = pcb.FLIP_DIRECTION_TOP_BOTTOM if hasattr(pcb, 'FLIP_DIRECTION_TOP_BOTTOM') else False
    for ref, ((x, y), rot, side) in place.items():
        f = fs[ref]
        if f.IsFlipped() != (side == 'B'): f.Flip(f.GetPosition(), flip)
        f.SetPosition(pt(50 + x, 50 + y)); f.SetOrientationDegrees(rot); f.Reference().SetPosition(f.GetPosition())
    return ', '.join(f'{r} ' + ' '.join(f'{p.GetNumber()}:({mm(p.GetPosition().x):.3f},{mm(p.GetPosition().y):.3f})' for p in fs[r].Pads()) for r in place)


def run(name, rip, add, rip_nets=(), place=None, pad_nets=None):
    phase = sys.argv[1] if len(sys.argv) > 1 else ''
    has_place = bool(place or pad_nets)
    assert phase in ('rip', 'add') or (has_place and phase == 'place'), 'run: rip, ' + ('place, ' if has_place else '') + 'add'
    b = pcb.LoadBoard(str(TARGET))
    if phase == 'rip': msg = f'{name} rip: {_rip(b, rip, rip_nets)} items'
    elif phase == 'place': msg = f'{name} place: ' + '; '.join(x for x in (_place(b, place or {}), _pad_nets(b, pad_nets or {})) if x)
    else: msg = f'{name} add: {_add(b, add)} items'
    pcb.SaveBoard(str(TARGET), b)
    print(msg, flush=True)
    os._exit(0)
