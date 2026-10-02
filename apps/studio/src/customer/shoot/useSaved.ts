import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The word at the end of a line that changed.
 *
 * "Saved" for 1.2 s after a write the camera kept as sent. "KINO adjusted
 * this." when the read-back differs, staying until the next interaction.
 * "KINO didn't save this." when the write failed, with a retry. No badge,
 * no timestamp, no revision number: the camera is the truth and the line
 * shows what it kept.
 */
export type RowMark = 'Saved' | 'KINO adjusted this.' | "KINO didn't save this." | null;

export const SAVED_HOLD_MS = 1200;

/** The mark for what a write came back with. */
export function markFor(outcome: { differs: boolean } | { failed: true }): RowMark {
  if ('failed' in outcome) return "KINO didn't save this.";
  return outcome.differs ? 'KINO adjusted this.' : 'Saved';
}

export function useRowMarks() {
  const [marks, setMarks] = useState<Record<string, RowMark>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const works = useRef<Record<string, () => Promise<boolean>>>({});

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  /**
   * Run a write for `row`. `work` resolves to true when the camera kept a
   * different value from the one sent. Any new interaction clears the marks
   * of every other row, which is how "adjusted" stays until the next touch.
   */
  const save = useCallback(async (row: string, work: () => Promise<boolean>) => {
    if (timer.current) clearTimeout(timer.current);
    works.current[row] = work;
    setMarks({});
    let mark: RowMark;
    try {
      mark = markFor({ differs: await work() });
    } catch {
      mark = markFor({ failed: true });
    }
    setMarks({ [row]: mark });
    if (mark === 'Saved') {
      timer.current = setTimeout(() => setMarks((m) => (m[row] === 'Saved' ? {} : m)), SAVED_HOLD_MS);
    }
  }, []);

  const retry = useCallback(
    (row: string) => {
      const work = works.current[row];
      if (work) void save(row, work);
    },
    [save],
  );

  const mark = useCallback((row: string): RowMark => marks[row] ?? null, [marks]);

  return { save, mark, retry } as const;
}
