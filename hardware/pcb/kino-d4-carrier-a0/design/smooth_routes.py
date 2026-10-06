"""Smooth grid routes that are already on the board (system python + numpy/scipy/numba).

Usage: python smooth_routes.py ROUTES.json [ROUTES.json ...]
Reads .cache/carrier-routing/grid-dump.json (dump the board first, with the routes applied) and
writes .cache/carrier-routing/smoothed.json: one {old, new} pair per route that changed.
replace_routes.py (KiCad python) then swaps the copper. Each smoothed route is rasterised before
the next one, so later routes keep clear of it; its old copper stays marked, which is conservative.
"""
import json, math, sys
import grid_router as gr

routes = []
for f in sys.argv[1:]:
    routes += json.loads(open(f).read())['routes']
L = {n: i for i, n in enumerate(gr.LAYERS)}
pairs, kept = [], 0
for r in routes:
    segs = r['segments']
    if not segs: continue
    polys = []
    for lay, ax, ay, bx, by in segs:
        l = L[lay]
        if polys and polys[-1][0] == l and abs(polys[-1][1][-1][0] - ax) < 1e-6 and abs(polys[-1][1][-1][1] - ay) < 1e-6:
            polys[-1][1].append([bx, by])
        else:
            polys.append((l, [[ax, ay], [bx, by]]))
    xs = [p[0] for _, v in polys for p in v]; ys = [p[1] for _, v in polys for p in v]
    ok, i0, j0 = gr.masks(r['net'], r['width'], (min(xs), min(ys), max(xs), max(ys)), r.get('keepaway', True))
    new = gr.smooth_polys(polys, ok, i0, j0)
    n = gr.nets[r['net']]
    nsegs = [[gr.LAYERS[l], a[0], a[1], b[0], b[1]] for l, v in new for a, b in zip(v, v[1:]) if a != b]
    for lay, ax, ay, bx, by in nsegs:
        gr.draw_track(L[lay], ax, ay, bx, by, r['width'], n)
    if len(nsegs) < len(segs):
        pairs.append({'old': r, 'new': dict(r, segments=nsegs)})
    else:
        kept += 1
(gr.CACHE / 'smoothed.json').write_text(json.dumps(pairs, indent=1))
print('smoothed', len(pairs), 'routes; unchanged', kept, '; segments',
      sum(len(p['old']['segments']) for p in pairs), '->', sum(len(p['new']['segments']) for p in pairs), flush=True)
