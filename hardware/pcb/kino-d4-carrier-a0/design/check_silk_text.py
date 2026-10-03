"""Silkscreen text check for the A0.2 board (KiCad 10 python). ODD JOBS 91, 94, 95, 177.

KiCad's silk_overlap test does not report one footprint's reference text over another's, so
this checks every visible silkscreen text (component references and board labels) per side:
  text    the text box overlaps another silk text on the same side
  pad     the text box overlaps a pad opening (mask) on that side
  body    the text box overlaps a part body (courtyard, or outline without one) on that side,
          including the text's own part
  graphic the text box overlaps a silkscreen graphic: a part outline or marking (including its own
          part's outline) or a board graphic such as the maker mark
  small   text under 0.8 mm high or 0.12 mm stroke (board minimum, rule 95)
  crowded two texts on one side closer than 0.5 mm: they read as one word (lines stacked in one
          board text block, at least 0.3 mm apart, are line spacing)
  ambiguous  a reference nearer another part's outline than its own (rule 91: readable references)
  direction  vertical text that does not read bottom to top from its own side, or upside-down text
             (front 90 degrees; back 270 degrees mirrored; keep-upright folds 90..270 by 180)
Boxes are the stroked glyph outline. Writes outputs/A02-SILK-TEXT.json; exits 1 on any finding.
"""
import json, sys
import pcbnew as pcb
from rework import ROOT, TARGET

b = pcb.LoadBoard(str(TARGET))
mm = lambda v: round(pcb.ToMM(v) - 50, 3)
SILK = {pcb.F_SilkS: 'F', pcb.B_SilkS: 'B'}
MASK = {'F': pcb.F_Mask, 'B': pcb.B_Mask}
CRT = {'F': pcb.F_CrtYd, 'B': pcb.B_CrtYd}
INSIDE_OK = set()                                # no reference inside its own part (assembly_labels.py keeps the XIAO socket references outside)

def box(t):
    r = t.GetEffectiveTextShape().BBox()
    return (r.GetLeft(), r.GetTop(), r.GetRight(), r.GetBottom())
def hit(a, c): return a[0] < c[2] and c[0] < a[2] and a[1] < c[3] and c[1] < a[3]
def dist(a, c): return pcb.ToMM(int(max(0, a[0] - c[2], c[0] - a[2]) ** 2 + max(0, a[1] - c[3], c[1] - a[3]) ** 2) ** .5)
def stacked(a, c, own_a, own_c):
    if own_a or own_c: return False
    ov = min(a[2], c[2]) - max(a[0], c[0])
    return ov > .5 * min(a[2] - a[0], c[2] - c[0]) and dist(a, c) >= .3
def reads(t, s):
    a = round(t.GetTextAngle().AsDegrees()) % 360
    if t.IsKeepUpright() and 90 < a <= 270: a = (a + 180) % 360
    return a in ((0, 90) if s == 'F' else (0, 270))

texts = []                                             # (name, side, box, text item, owner ref)
for f in b.GetFootprints():
    t = f.Reference()
    if t.IsVisible() and t.GetLayer() in SILK and t.GetText():
        texts.append((f.GetReference(), SILK[t.GetLayer()], box(t), t, f.GetReference()))
for d in b.GetDrawings():
    if isinstance(d, pcb.PCB_TEXT) and d.GetLayer() in SILK and d.GetText().strip():
        texts.append((d.GetText().replace('\n', ' '), SILK[d.GetLayer()], box(d), d, None))
pads = {'F': [], 'B': []}
bodies = {'F': [], 'B': []}
outlines = {'F': [], 'B': []}
for f in b.GetFootprints():
    for p in f.Pads():
        r = p.GetBoundingBox()
        for s in 'FB':
            if p.IsOnLayer(MASK[s]): pads[s].append((f'{f.GetReference()}.{p.GetNumber()}', (r.GetLeft(), r.GetTop(), r.GetRight(), r.GetBottom())))
    s = 'B' if f.IsFlipped() else 'F'
    c = f.GetCourtyard(CRT[s])
    r = c.BBox() if c.OutlineCount() else f.GetBoundingBox(False, False)
    bodies[s].append((f.GetReference(), (r.GetLeft(), r.GetTop(), r.GetRight(), r.GetBottom())))
    o = f.GetBoundingBox(False, False)
    outlines[s].append((f.GetReference(), (o.GetLeft(), o.GetTop(), o.GetRight(), o.GetBottom())))

graphics = {'F': [], 'B': []}
for f in b.GetFootprints():
    for g in f.GraphicalItems():
        if g.GetLayer() in SILK and not isinstance(g, pcb.PCB_TEXT):
            r = g.GetBoundingBox(); graphics[SILK[g.GetLayer()]].append((f.GetReference() + ' outline', (r.GetLeft(), r.GetTop(), r.GetRight(), r.GetBottom())))
for d in b.GetDrawings():
    if d.GetLayer() in SILK and not isinstance(d, pcb.PCB_TEXT):
        r = d.GetBoundingBox(); graphics[SILK[d.GetLayer()]].append(('board graphic', (r.GetLeft(), r.GetTop(), r.GetRight(), r.GetBottom())))
found = []
for i, (name, s, q, t, own) in enumerate(texts):
    for name2, s2, q2, _, _ in texts[i + 1:]:
        if s == s2 and hit(q, q2): found.append({'kind': 'text', 'side': s, 'a': name, 'b': name2})
        elif s == s2 and dist(q, q2) < 0.5 - 1e-3 and not stacked(q, q2, own, texts[i + 1 + [n for n, *_ in texts[i + 1:]].index(name2)][4]): found.append({'kind': 'crowded', 'side': s, 'a': name, 'b': name2, 'gap_mm': round(dist(q, q2), 2)})
    if not reads(t, s): found.append({'kind': 'direction', 'side': s, 'a': name, 'b': f'{t.GetTextAngle().AsDegrees():.0f} deg'})
    if own:
        d_own = next(dist(q, o) for r, o in outlines[s] if r == own)
        near = min(((dist(q, o), r) for r, o in outlines[s] if r != own), default=(99, None))
        if near[0] < d_own - 1e-3: found.append({'kind': 'ambiguous', 'side': s, 'a': name, 'b': near[1], 'own_mm': round(d_own, 2), 'other_mm': round(near[0], 2)})
    for gn, gq in graphics[s]:
        if hit(q, gq): found.append({'kind': 'graphic', 'side': s, 'a': name, 'b': gn})
    for pn, pq in pads[s]:
        if hit(q, pq): found.append({'kind': 'pad', 'side': s, 'a': name, 'b': pn})
    for ref, bq in bodies[s]:
        if hit(q, bq) and not (own == ref and own in INSIDE_OK): found.append({'kind': 'body', 'side': s, 'a': name, 'b': ref})
    if pcb.ToMM(t.GetTextHeight()) < 0.8 - 1e-6 or pcb.ToMM(t.GetTextThickness()) < 0.12 - 1e-6:
        found.append({'kind': 'small', 'side': s, 'a': name, 'b': f'{pcb.ToMM(t.GetTextHeight()):.2f} mm'})
for f_ in found:
    q = next(q for n, s, q, _, _ in texts if n == f_['a'] and s == f_['side'])
    f_['at_mm'] = [mm((q[0] + q[2]) // 2), mm((q[1] + q[3]) // 2)]
fab = sorted(f.GetReference() for f in b.GetFootprints() if f.Reference().GetLayer() in (pcb.F_Fab, pcb.B_Fab))
by = {}
for f_ in found: by[f_['kind']] = by.get(f_['kind'], 0) + 1
(ROOT / 'outputs/A02-SILK-TEXT.json').write_text(json.dumps({
    'board': TARGET.name, 'silk_texts': len(texts), 'findings': len(found), 'by_kind': by,
    'references_on_fab_only': fab, 'items': found}, indent=1) + '\n')
print(f'silk texts {len(texts)}; findings {len(found)} {by}; references on Fab only: {len(fab)}', flush=True)
for f_ in found[:int(sys.argv[1]) if len(sys.argv) > 1 else 40]: print(' ', f_)
import os; os._exit(1 if found else 0)
