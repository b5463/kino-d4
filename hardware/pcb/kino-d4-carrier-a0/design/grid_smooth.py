"""Route smoothing geometry for grid_router.py (ODD JOBS 88: no zig-zag).

smooth_run rebuilds one layer run greedily: from a vertex, the farthest later vertex reachable by one
straight-plus-45-degree connection on clear cells replaces everything between. It keeps the first and
last directions when asked, allows no corner sharper than 90 degrees and no new run below min_len.
cell(x, y) maps millimetres to grid (column, row); okl is the clear-cell mask of the run's layer.
"""
import math

def _unit(a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]; L = math.hypot(dx, dy)
    return (dx / L, dy / L) if L > 1e-9 else None

def _clear(okl, a, b, i0, j0, cell, res):
    L = math.hypot(b[0] - a[0], b[1] - a[1]); n = max(1, int(L / (res / 2)))
    for k in range(n + 1):
        x = a[0] + (b[0] - a[0]) * k / n; y = a[1] + (b[1] - a[1]) * k / n
        i, j = cell(x, y); i -= i0; j -= j0
        if not (0 <= j < okl.shape[0] and 0 <= i < okl.shape[1]) or not okl[j, i]: return False
    return True

def _octi(P, Q):
    dx, dy = Q[0] - P[0], Q[1] - P[1]; ax, ay = abs(dx), abs(dy)
    if ax < 1e-6 or ay < 1e-6 or abs(ax - ay) < 1e-6: return [[Q]]
    sx, sy = math.copysign(1, dx), math.copysign(1, dy); d = min(ax, ay)
    return [[(P[0] + sx * d, P[1] + sy * d), Q], [(Q[0] - sx * d, Q[1] - sy * d), Q]]

def smooth_run(pts, okl, i0, j0, fix_first, fix_last, cell, res, min_len):
    pts = [tuple(p) for p in pts]
    n = len(pts)
    if n < 3: return pts
    d_first, d_last = _unit(pts[0], pts[1]), _unit(pts[-2], pts[-1])
    out = [pts[0]]; i = 0
    while i < n - 1:
        for j in range(n - 1, i, -1):
            if j == i + 1:
                out.append(pts[j]); i = j; break
            hit = None
            for c in _octi(out[-1], pts[j]):
                seq = [out[-1]] + c
                good = True
                for a, b in zip(seq, seq[1:]):
                    if math.hypot(b[0] - a[0], b[1] - a[1]) < min_len or not _clear(okl, a, b, i0, j0, cell, res):
                        good = False; break
                if not good: continue
                u0 = _unit(seq[0], seq[1]); u1 = _unit(seq[-2], seq[-1])
                if len(out) >= 2:
                    up = _unit(out[-2], out[-1])
                    if up[0] * u0[0] + up[1] * u0[1] < -1e-6: continue          # sharper than 90 degrees
                elif fix_first and (abs(u0[0] - d_first[0]) > 1e-6 or abs(u0[1] - d_first[1]) > 1e-6): continue
                if j < n - 1:
                    un = _unit(pts[j], pts[j + 1])
                    if u1[0] * un[0] + u1[1] * un[1] < -1e-6: continue
                elif fix_last and (abs(u1[0] - d_last[0]) > 1e-6 or abs(u1[1] - d_last[1]) > 1e-6): continue
                hit = c; break
            if hit:
                out += hit; i = j; break
    # merge collinear vertices
    res = [out[0]]
    for k in range(1, len(out) - 1):
        a, b = _unit(res[-1], out[k]), _unit(out[k], out[k + 1])
        if a and b and abs(a[0] - b[0]) < 1e-6 and abs(a[1] - b[1]) < 1e-6: continue
        res.append(out[k])
    res.append(out[-1])
    return res
