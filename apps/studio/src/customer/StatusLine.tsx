import { useState } from 'react';
import type { AttentionRow, AttentionTarget } from './attention';
import { attentionLine } from './attention';

/**
 * The line above the page. Empty when there is nothing to say. One sentence
 * when something matters; "See what" opens the list when several do. The
 * shell's own sentences (restarting, updating, busy) take the line first.
 */
export function StatusLine({
  sentence,
  rows,
  onAction,
}: {
  /** The shell's sentence, or null to let attention speak. */
  sentence: string | null;
  rows: AttentionRow[];
  onAction: (target: AttentionTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  const line = sentence ? null : attentionLine(rows);

  if (sentence) {
    return (
      <p className="c-status" role="status">
        {sentence}
      </p>
    );
  }
  if (!line) {
    return <p className="c-status" role="status" aria-label="Nothing needs attention" />;
  }
  const act = () => {
    if (line.single) {
      if (line.single.action) onAction(line.single.action.target);
    } else {
      setOpen((o) => !o);
    }
  };
  return (
    <>
      <p className="c-status" role="status">
        <span>{line.sentence}</span>
        {line.action ? (
          <button type="button" className="c-status-see" aria-expanded={line.single ? undefined : open} onClick={act}>
            {line.action}
          </button>
        ) : null}
      </p>
      {open && !line.single ? (
        <ul className="c-attention" aria-label="What needs attention">
          {rows.map((row) => (
            <li key={row.id}>
              <span>{row.sentence}</span>
              {row.action ? (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onAction(row.action!.target);
                  }}
                >
                  {row.action.label}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
