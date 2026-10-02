"""Compiled A* core for grid_router.py (numba 0.68, pip install numba).

Pure function of numpy arrays: clear-cell masks, soft costs, via sites, start and goal costs.
It knows nothing about nets or the board; grid_router.py builds the inputs and reads the path.
"""
import heapq, math
import numpy as np
from numba import njit

# ---- compiled search core (numba) ----
# State index ((layer * h + row) * w + col) * 9 + heading; heading 8 = none yet (start or after a via).
# came[] holds how a state was reached: 255 start; < 144 a move ((dir * 2 + jump) * 9 + previous heading);
# 144.. a via (144 + previous layer * 9 + previous heading). A bend, and the first move after a start or
# a via, is a jump of min_run cells, so every run between bends has at least that length.
_DX = np.array([1, 1, 0, -1, -1, -1, 0, 1], np.int64)
_DY = np.array([0, 1, 1, 1, 0, -1, -1, -1], np.int64)

@njit(cache=True)
def _astar(ok, pen, vok, scost, smask, gcost, gdir, lcost, bend, via_cost, min_run, limit, gx0, gx1, gy0, gy1, DX, DY, hw):
    NL, h, w = ok.shape
    N = NL * h * w * 9
    g = np.full(N, np.inf, np.float32)
    came = np.full(N, 254, np.uint8)
    heap = [(0.0, 0.0, np.int64(0))]
    heap.pop()
    r2 = math.sqrt(2.0) - 1.0
    for l in range(NL):
        for y in range(h):
            for x in range(w):
                c0 = scost[l, y, x]
                if c0 < np.inf:
                    s = ((l * h + y) * w + x) * 9 + 8
                    g[s] = c0; came[s] = 255
                    dx = max(gx0 - x, 0, x - gx1); dy = max(gy0 - y, 0, y - gy1)
                    heapq.heappush(heap, (c0 + hw * (max(dx, dy) + r2 * min(dx, dy)), np.float64(c0), np.int64(s)))
    seen = 0
    while len(heap) > 0:
        f, gc, code = heapq.heappop(heap)
        if code < 0:
            s = -code - 1
            out = []
            while True:
                d = s % 9; c = s // 9; x = c % w; y = (c // w) % h; l = c // (w * h)
                out.append((l, y, x))
                m = came[s]
                if m == 255: break
                if m < 144:
                    mv = m // 9; pd = m % 9; k = mv // 2; st = min_run if mv % 2 == 1 else 1
                    s = ((l * h + (y - st * DY[k])) * w + (x - st * DX[k])) * 9 + pd
                else:
                    v = m - 144; s = ((v // 9 * h + y) * w + x) * 9 + v % 9
            return out, 0
        if gc > g[code]: continue
        d = code % 9; c = code // 9; x = c % w; y = (c // w) % h; l = c // (w * h)
        if d < 8 and gcost[l, y, x] < np.inf and came[code] != 255 and (gdir[l, y, x] >> d) & 1:
            ng = gc + gcost[l, y, x]
            heapq.heappush(heap, (ng, ng, np.int64(-code - 1)))
        seen += 1
        if seen > limit:
            return [(np.int64(0), np.int64(0), np.int64(0))][:0], 1
        start = came[code] == 255
        for k in range(8):
            if start and not (smask[l, y, x] >> k) & 1: continue
            if d == 8:
                turn = 0
            else:
                t1 = (k - d) % 8; turn = min(t1, 8 - t1)
            if turn >= 3: continue
            steps = 1 if (turn == 0 and d != 8) else min_run
            px = x; py = y; cost = bend[turn]; good = True
            diag = DX[k] != 0 and DY[k] != 0
            for _ in range(steps):
                nx = px + DX[k]; ny = py + DY[k]
                if nx < 0 or nx >= w or ny < 0 or ny >= h:
                    good = False; break
                if not ok[l, ny, nx] and not gcost[l, ny, nx] < np.inf:
                    good = False; break
                if diag and not (ok[l, py, nx] or ok[l, ny, px]):
                    good = False; break
                cost += (1.4142 if diag else 1.0) * lcost[l] + pen[l, ny, nx]
                px = nx; py = ny
            if not good: continue
            ng = gc + cost
            t = ((l * h + py) * w + px) * 9 + k
            if ng < g[t]:
                g[t] = ng; came[t] = ((k * 2 + (1 if steps > 1 else 0)) * 9 + d)
                dx = max(gx0 - px, 0, px - gx1); dy = max(gy0 - py, 0, py - gy1)
                heapq.heappush(heap, (ng + hw * (max(dx, dy) + r2 * min(dx, dy)), ng, np.int64(t)))
        if vok[y, x] and not scost[l, y, x] < np.inf and d != 8:
            for l2 in range(NL):
                if l2 == l or not ok[l2, y, x]: continue
                t = ((l2 * h + y) * w + x) * 9 + 8
                ng = gc + via_cost
                if ng < g[t]:
                    g[t] = ng; came[t] = 144 + l * 9 + d
                    dx = max(gx0 - x, 0, x - gx1); dy = max(gy0 - y, 0, y - gy1)
                    heapq.heappush(heap, (ng + hw * (max(dx, dy) + r2 * min(dx, dy)), ng, np.int64(t)))
    return [(np.int64(0), np.int64(0), np.int64(0))][:0], 2
