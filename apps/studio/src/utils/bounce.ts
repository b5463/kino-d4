/**
 * Viewpoint order for wiggle playback and every animated export, over the
 * frames that are actually present.
 *
 * This used to be the constant `[0,1,2,3,2,1]`, in two copies. A grouped
 * capture stores only the cameras that answered (firmware-contract D23), so a
 * three-frame capture indexed `frames[3]` — `undefined.url` — and took the
 * whole application down with it. Out and back over whatever is there: two
 * frames bounce 0,1; one frame holds still; none is an empty sequence.
 */
export function bounceSequence(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(i);
  for (let i = count - 2; i > 0; i--) out.push(i);
  return out;
}
