"""One readable assembly reference per component, beside its own part (KiCad 10 python).

ODD JOBS 91, 94, 95, 177. Prototype boards keep every reference on the silkscreen (--prototype-silk;
otherwise the references go on Fab). Each reference is placed beside its own part body: candidates sit
along each side of the part outline, 0.25 to 3 mm away, sliding in 0.25 mm steps, horizontal or
vertical. A candidate must keep
  - 0.15 mm from every part outline on that side (the outline includes the courtyard, so pads stay
    at least 0.4 mm clear), 0.2 mm from the through-holes of parts on the other side, clear of the
    fasteners,
  - 0.5 mm from every other silkscreen text or marking, so neighbouring references read as
    separate words,
  - 0.5 mm inside the board edge.
Of those, the nearest wins, with penalties for a label not at least 0.3 mm nearer its own part than
any other part, for text across the part's long axis, and for sliding off the middle of
the part's side (each label lines up with its own part: centred on it where the spot is clear, and
centred spots are tried first); a spot not at least 0.1 mm nearer its own part than any other is never used: such references go to Fab. Horizontal text reads left to
right; vertical text reads bottom to top from the side it is on (front 90 degrees, back 270 degrees
mirrored, keep-upright off). 1.0 mm text first; 0.8 mm (the board minimum) where 1.0 mm finds no
spot or only an ambiguous one. Parts with the fewest clear spots are labelled first. The four camera
circuits share offsets where that leaves every one of them unambiguous. The XIAO socket references
sit outside the sockets, where the fitted modules do not hide them. Values stay in the BOM and properties. Documentation geometry only, never copper.
check_silk_text.py verifies the result.
"""
import json, math, sys
from collections import defaultdict
import pcbnew as pcb
from rework import ROOT, TARGET
from routing import pt, pos, rect, intersects
from mechanical import WIDTH, HEIGHT, INSERT_CENTRES

prototype = '--prototype-silk' in sys.argv
SIZES = [(1.0, .15), (.8, .15)] if prototype else [(.8, .15)]   # 0.15 mm stroke: the fab's minimum legend line
BODY_GAP, TEXT_GAP, EDGE, AMBIGUITY = .15, .25, .5, .3
ALIGN = float(__import__('os').environ.get('LBL_ALIGN', .6))                     # score per mm a label sits off the middle of its part's side
GAPS = [.25 * i for i in range(1, 17)]
VERT = {'F': 90, 'B': 270}
INSIDE_OK = set()                # nothing inside a part outline: the XIAO socket references between the pin rows were hidden by the fitted modules

b = pcb.LoadBoard(str(TARGET)); fs = {f.GetReference(): f for f in b.GetFootprints()}
MARKS = {r for r in fs if r.startswith('FID')}  # fiducials: obstacles here, never labelled (add_a02_fiducials.py keeps them on Fab)
FAB = {'R1003': 'every clear spot sits over C1102 or R1106 (R1106 itself on Fab), not beside R1003',
       'R1110': 'DNP; its only spot is over R1102, a fitted part of another value'}
side_of = lambda f: 'B' if f.IsFlipped() else 'F'
grow = lambda q, m: (q[0] - m, q[1] - m, q[2] + m, q[3] + m)
def box(r, m=0.): return (r.GetLeft() / 1e6 - 50 - m, r.GetTop() / 1e6 - 50 - m, r.GetRight() / 1e6 - 50 + m, r.GetBottom() / 1e6 - 50 + m)
def tbox(t, m=0.): return box(t.GetEffectiveTextShape().BBox(), m)
def dist(a, c): return math.hypot(max(0, a[0] - c[2], c[0] - a[2]), max(0, a[1] - c[3], c[1] - a[3]))

class Bins:
    """Boxes in 5 mm cells."""
    def __init__(s): s.d = defaultdict(list)
    def keys(s, q): return [(x, y) for x in range(math.floor(q[0] / 5), math.floor(q[2] / 5) + 1) for y in range(math.floor(q[1] / 5), math.floor(q[3] / 5) + 1)]
    def add(s, name, q):
        for k in s.keys(q): s.d[k].append((name, q))
    def hit(s, q, skip=None):
        return next((n for k in s.keys(q) for n, o in s.d[k] if n != skip and intersects(q, o)), None)
    def near(s, q):
        return {n: o for k in s.keys(q) for n, o in s.d[k]}
    def hits(s, q):
        return {n for k in s.keys(q) for n, o in s.d[k] if intersects(q, o)}
    def remove(s, name):
        out = None
        for k in s.d:
            keep = [(n, o) for n, o in s.d[k] if n != name]
            if len(keep) != len(s.d[k]): out = next(o for n, o in s.d[k] if n == name)
            s.d[k] = keep
        return out
hard = {'F': Bins(), 'B': Bins()}       # part bodies, pads, through-holes, fasteners
text = {'F': Bins(), 'B': Bins()}       # silkscreen texts and markings, each grown by TEXT_GAP
bodies = {'F': Bins(), 'B': Bins()}     # bare part outlines, for the ambiguity test
own_rect = {r: rect(f, 0) for r, f in fs.items()}
for r, f in fs.items():
    for g in list(f.GraphicalItems()):   # stock library centre references duplicate the reference field
        if isinstance(g, pcb.PCB_TEXT) and g.GetText() in ('${REFERENCE}', '%R'): g.SetText(''); g.SetVisible(False)
    f.Value().SetVisible(False)
    s = side_of(f)
    hard[s].add(r, own_rect[r]); bodies[s].add(r, own_rect[r])
    for p in f.Pads():
        if p.GetAttribute() in (pcb.PAD_ATTRIB_PTH, pcb.PAD_ATTRIB_NPTH): hard['F' if s == 'B' else 'B'].add(r + ' hole', box(p.GetBoundingBox(), .05))
        if r in INSIDE_OK: hard[s].add(r + ' pad', box(p.GetBoundingBox(), .05))
for d in b.GetDrawings():
    if d.GetLayer() in (pcb.F_SilkS, pcb.B_SilkS):
        text['B' if d.GetLayer() == pcb.B_SilkS else 'F'].add('board marking', tbox(d, TEXT_GAP) if isinstance(d, pcb.PCB_TEXT) else box(d.GetBoundingBox(), TEXT_GAP))
for x, y in INSERT_CENTRES:
    for s in 'FB': hard[s].add('fastener', (x - 3.5, y - 3.5, x + 3.5, y + 3.5))
for r in MARKS:                         # fiducials: no silk within 1 mm of the 2 mm mask opening
    x, y = pos(fs[r]); hard[side_of(fs[r])].add(r + ' clear', (x - 2.05, y - 2.05, x + 2.05, y + 2.05))

def style(f, size):
    t = f.Reference(); s = side_of(f)
    t.SetVisible(True); t.SetMirrored(s == 'B'); t.SetKeepUpright(False)
    t.SetLayer((pcb.B_SilkS if s == 'B' else pcb.F_SilkS) if prototype else (pcb.B_Fab if s == 'B' else pcb.F_Fab))
    t.SetTextSize(pt(size[0], size[0])); t.SetTextThickness(pcb.FromMM(size[1]))
    t.SetHorizJustify(pcb.GR_TEXT_H_ALIGN_CENTER); t.SetVertJustify(pcb.GR_TEXT_V_ALIGN_CENTER)
def shape(f, vertical):
    """Text box width, height and box-centre offset from the text position."""
    t = f.Reference(); x, y = pos(f)
    t.SetTextAngle(pcb.EDA_ANGLE(VERT[side_of(f)] if vertical else 0, pcb.DEGREES_T)); t.SetPosition(pt(50 + x, 50 + y))
    q = tbox(t); return q[2] - q[0], q[3] - q[1], (q[0] + q[2]) / 2 - x, (q[1] + q[3]) / 2 - y
def candidates(r, w, h):
    """(key, box centre, least distance to own outline), nearest first; keys match across identical parts."""
    o = own_rect[r]; cx, cy = (o[0] + o[2]) / 2, (o[1] + o[3]) / 2
    if r in INSIDE_OK:
        for kx in range(-24, 25):
            for ky in range(-24, 25):
                c = (cx + kx * .25, cy + ky * .25)
                if o[0] <= c[0] - w / 2 and c[0] + w / 2 <= o[2] and o[1] <= c[1] - h / 2 and c[1] + h / 2 <= o[3]: yield ('in', kx, ky), c, 0.
    kx, ky = int(((o[2] - o[0]) / 2 + w / 2) / .25), int(((o[3] - o[1]) / 2 + h / 2) / .25)
    centred = lambda n: sorted(range(-n, n + 1), key=abs)    # 0, -1, 1, -2, 2 ...: aligned spots first
    for g in GAPS:
        for k in centred(kx):
            yield ('S', g, k), (cx + k * .25, o[3] + g + h / 2), g
            yield ('N', g, k), (cx + k * .25, o[1] - g - h / 2), g
        for k in centred(ky):
            yield ('W', g, k), (o[0] - g - w / 2, cy + k * .25), g
            yield ('E', g, k), (o[2] + g + w / 2, cy + k * .25), g
def judge(r, s, w, h, c, vertical):
    """None if the box is blocked, else (score, ambiguity, distance to own part)."""
    q = (c[0] - w / 2, c[1] - h / 2, c[0] + w / 2, c[1] + h / 2)
    if q[0] < EDGE or q[1] < EDGE or q[2] > WIDTH - EDGE or q[3] > HEIGHT - EDGE: return None
    if hard[s].hit(grow(q, BODY_GAP), r if r in INSIDE_OK else None) or text[s].hit(grow(q, TEXT_GAP)): return None
    o = own_rect[r]; d_own = dist(q, o)
    d_other = min((dist(q, p) for n, p in bodies[s].near(grow(q, d_own + AMBIGUITY + .5)).items() if n != r), default=99.)
    amb = max(0., d_own + AMBIGUITY - d_other)
    if amb > AMBIGUITY - .1: return None                   # never as near another part as its own (0.1 mm margin)
    pw, ph = o[2] - o[0], o[3] - o[1]
    want = True if ph > 1.3 * pw else False if pw > 1.3 * ph else None
    pen = (.15 if vertical else 0.) if want is None else (0. if want == vertical else .4)
    return d_own + 4 * amb + pen + ALIGN * slide(o, q), amb, d_own
def slide(o, q):
    """How far the label's centre sits off the middle of the part side it is on (mm); a label that
    also leaves the part's span costs double for the part beyond it."""
    cx, cy = (o[0] + o[2]) / 2, (o[1] + o[3]) / 2; qx, qy = (q[0] + q[2]) / 2, (q[1] + q[3]) / 2
    if q[3] <= o[1] or q[1] >= o[3]: d, half = abs(qx - cx), (o[2] - o[0]) / 2     # above or below the part
    else: d, half = abs(qy - cy), (o[3] - o[1]) / 2                                 # beside it
    return d + max(0., d - half)

placed, unplaced, records = set(), [], []
def commit(f, vertical, c, offs, j, how, size):
    t = f.Reference(); s = side_of(f)
    t.SetTextAngle(pcb.EDA_ANGLE(VERT[s] if vertical else 0, pcb.DEGREES_T))
    t.SetPosition(pt(50 + c[0] - offs[0], 50 + c[1] - offs[1]))
    q = tbox(t); text[s].add(f.GetReference() + ' label', grow(q, TEXT_GAP)); placed.add(f.GetReference())
    if f.GetReference() in unplaced: unplaced.remove(f.GetReference())
    x, y = pos(f); tx, ty = pos(t)
    records.append({'reference': f.GetReference(), 'side': s, 'text_xy_mm': [round(tx, 3), round(ty, 3)],
                    'offset_mm': [round(tx - x, 3), round(ty - y, 3)], 'angle_deg': VERT[s] if vertical else 0,
                    'text_height_mm': size[0], 'bounding_box_mm': [round(v, 3) for v in q],
                    'distance_to_own_part_mm': round(j[2], 2), 'ambiguity_mm': round(j[1], 2), 'placement': how})
def place(refs, size, how='search', strict=False):
    ff = [fs[r] for r in refs]
    for f in ff: style(f, size)
    best = None
    for vertical in (False, True):
        shp = [shape(f, vertical) for f in ff]
        cands = [list(candidates(f.GetReference(), w, h)) for f, (w, h, _, _) in zip(ff, shp)]
        others = [dict((k, c) for k, c, _ in cd) for cd in cands[1:]]
        for key, c0, g in cands[0]:
            if best and g * len(ff) > best[0]: break          # nearest first: nothing further can win
            cs = [c0] + [o.get(key) for o in others]
            if None in cs: continue
            js = [judge(f.GetReference(), side_of(f), w, h, c, vertical) for f, (w, h, _, _), c in zip(ff, shp, cs)]
            if None in js or (strict and any(j[1] > 0 for j in js)): continue
            sc = sum(j[0] for j in js)
            if best is None or sc < best[0]: best = (sc, vertical, shp, cs, js)
    if best is None:
        if not strict: unplaced.extend(r for r in refs if r not in unplaced and r not in placed)
        return False
    _, vertical, shp, cs, js = best
    for f, s_, c, j in zip(ff, shp, cs, js): commit(f, vertical, c, s_[2:], j, how, size)
    return True

# Explicit banks: rows of matching parts read as rows. Skipped where they no longer fit.
banks = {**{f'C{1111 + i}': (84.5 - 3 * i, 51.3, True, SIZES[0]) for i in range(5)},
         'C1117': (80.5, 54.65, False, SIZES[0]), 'C1118': (74.8, 54.65, False, SIZES[0]),
         'C1105': (99.5, 45.28, True, SIZES[-1])}      # above its own part: the 1.0 mm pass found only a spot 2.7 mm away
for r, (x, y, vertical, size) in banks.items():
    f = fs[r]; s = side_of(f); style(f, size); w, h, ox, oy = shape(f, vertical)
    j = judge(r, s, w, h, (x + ox, y + oy), vertical)
    if j and j[1] == 0: commit(f, vertical, (x + ox, y + oy), (ox, oy), j, 'explicit spot', size)
# The four camera circuits use one convention: each group of four matching parts (one per camera)
# takes the same offset from its own part, unambiguous where possible. A group that fits nowhere
# together goes to Fab as a whole rather than half on silk; sockets, breakout headers, power links and test points
# are always labelled, so they fall back to individual placement instead.
GROUPS = [('J', 0), ('J', 1), ('JP', 0), ('U', 0), ('U', 1), ('RS', 0), ('D', 0),
          *[(s, i) for s, n in [('C', 5), ('R', 6), ('TP', 2)] for i in range(n)]]
MUST_LABEL = {('J', 0), ('J', 1), ('JP', 0), ('TP', 0), ('TP', 1)}
grouped, fab_only = set(), set(FAB)
unplaced.extend(sorted(FAB))
for stem, off in GROUPS:
    refs = [stem + str(200 + 100 * i + off) for i in range(4)]
    if not all(r in fs and r not in placed for r in refs): continue
    if any(place(refs, sz, 'camera group', strict=True) for sz in SIZES) or \
       ((stem, off) in MUST_LABEL and any(place(refs, sz, 'camera group', strict=False) for sz in SIZES)):   # ambiguous groups go to Fab
        grouped.update(refs); continue
    if (stem, off) not in MUST_LABEL:
        fab_only.update(refs); unplaced.extend(r for r in refs if r not in unplaced)
def options(r, size):
    f = fs[r]; style(f, size); n = 0
    for vertical in (False, True):
        w, h, _, _ = shape(f, vertical)
        n += sum(1 for _, c, _ in candidates(r, w, h) if judge(r, side_of(f), w, h, c, vertical))
    return n
for strict, size in [(True, s) for s in SIZES] + [(False, s) for s in SIZES]:   # unambiguous first, at either size
    todo = [r for r in fs if r not in placed and r not in fab_only and r not in MARKS and r not in FAB]
    count = {r: options(r, size) for r in todo}
    for r in sorted(todo, key=lambda r: (count[r], pos(fs[r])[1], pos(fs[r])[0])):
        if r not in placed: place([r], size, strict=strict)
# Repair: a reference with no clear spot may take an unambiguous one blocked by a single other label,
# if that label has another spot no more ambiguous than its own (at either size). Repeats until
# nothing more moves.
def best_spot(r, size, max_amb=0.):
    f = fs[r]; style(f, size); best = None
    for vertical in (False, True):
        shp = shape(f, vertical)
        for key, c, g in candidates(r, shp[0], shp[1]):
            if best and g > best[0]: break
            j = judge(r, side_of(f), shp[0], shp[1], c, vertical)
            if j and j[1] <= max_amb and (best is None or j[0] < best[0]): best = (j[0], vertical, shp, c, j, size)
    return best
def save(f):                             # copies: the bindings hand back live references to the text's own fields
    t = f.Reference(); q, z = t.GetPosition(), t.GetTextSize()
    return (pcb.VECTOR2I(q.x, q.y), t.GetTextAngle().AsDegrees(), pcb.VECTOR2I(z.x, z.y), int(t.GetTextThickness()), int(t.GetLayer()))
def restore(f, st):
    t = f.Reference(); t.SetPosition(st[0]); t.SetTextAngle(pcb.EDA_ANGLE(st[1], pcb.DEGREES_T))
    t.SetTextSize(st[2]); t.SetTextThickness(st[3]); t.SetLayer(st[4])
moved = True
while moved:
    moved = False
    for r in list(unplaced):
        if r in fab_only: continue
        f = fs[r]; s = side_of(f); done = False
        for size in SIZES:
            for vertical in (False, True):
                style(f, size); w, h, ox, oy = shape(f, vertical)
                for key, c, g in candidates(r, w, h):
                    q = (c[0] - w / 2, c[1] - h / 2, c[0] + w / 2, c[1] + h / 2)
                    blk = text[s].hits(grow(q, TEXT_GAP))
                    if len(blk) != 1 or not next(iter(blk)).endswith(' label'): continue
                    x = next(iter(blk))[:-6]
                    if x in grouped: continue                     # a camera group moves together or not at all
                    fx = fs[x]; st = save(fx)
                    old = text[s].remove(x + ' label')
                    j = judge(r, s, w, h, c, vertical)
                    if j is None or j[1] > 0: text[s].add(x + ' label', old); continue     # repaired labels are unambiguous
                    text[s].add(r + ' label', grow(q, TEXT_GAP))
                    x_amb = next((q_['ambiguity_mm'] for q_ in records if q_['reference'] == x), 0.)
                    alt = next((a for sz in SIZES for a in [best_spot(x, sz, x_amb)] if a), None)   # and the moved one no worse
                    text[s].remove(r + ' label')
                    if alt is None:
                        restore(fx, st); text[s].add(x + ' label', old); style(f, size); shape(f, vertical); continue
                    style(f, size); shape(f, vertical)
                    commit(f, vertical, c, (ox, oy), j, 'repair', size)
                    records[:] = [q_ for q_ in records if q_['reference'] != x]
                    _, xv, xs, xc, xj, xsz = alt
                    style(fx, xsz); shape(fx, xv)
                    commit(fx, xv, xc, xs[2:], xj, 'moved for ' + r, xsz)
                    done = moved = True; break
                if done: break
            if done: break
for r in unplaced:                       # recorded, not dropped: the assembly drawing keeps it at the part centre
    f = fs[r]; t = f.Reference(); style(f, SIZES[-1]); t.SetLayer(pcb.B_Fab if f.IsFlipped() else pcb.F_Fab)
    t.SetTextAngle(pcb.EDA_ANGLE(0, pcb.DEGREES_T)); t.SetPosition(f.GetPosition())
unfinished = ROOT / 'outputs/A02-ASSEMBLY-LABELS-UNFINISHED.json'
if unplaced: unfinished.write_text(json.dumps({'unplaced': unplaced, 'reason': 'no clear position beside the part; reference kept on Fab at the part centre'}, indent=2) + '\n')
elif unfinished.exists(): unfinished.unlink()
assert len(placed) + len(unplaced) + len(MARKS) == len(fs), (len(placed), len(unplaced), len(fs))
pcb.SaveBoard(str(TARGET), b)
small = sum(1 for q in records if q['text_height_mm'] < SIZES[0][0])
amb = [q['reference'] for q in records if q['ambiguity_mm'] > 0]
(ROOT / 'outputs/A02-ASSEMBLY-LABELS.json').write_text(json.dumps({
    'board': TARGET.name, 'text_height_mm': [s[0] for s in SIZES], 'text_stroke_mm': [s[1] for s in SIZES],
    'reference_layers': 'F.SilkS/B.SilkS' if prototype else 'F.Fab/B.Fab', 'reference_count': len(records),
    'at_fallback_height': small, 'ambiguous': amb, 'duplicate_centre_references_removed': True,
    'component_outline_margin_mm': .18 + BODY_GAP, 'text_to_text_gap_mm': 2 * TEXT_GAP,
    'placement': 'beside its own part, clear of bodies, pads, through-holes, fasteners and other silkscreen text',
    'labels': records}, indent=2) + '\n')
print(f'Placed {len(records)} references ({small} at {SIZES[-1][0]} mm, {len(amb)} ambiguous: {amb}); '
      f'{len(unplaced)} on Fab only: {unplaced}', flush=True)
import os; os._exit(0)
