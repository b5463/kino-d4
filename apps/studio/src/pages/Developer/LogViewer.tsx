import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import {
  LOG_FILTERS,
  clearLogs,
  filterEntries,
  setLogFilter,
  setLogPaused,
  useLogStore,
} from '../../state/logStore';
import type { LogSource } from '@kino/kdp';
import { formatLogTime } from '../../utils/format';
import { downloadText } from '../../utils/download';

const SRC_CLASS: Partial<Record<LogSource, string>> = {
  PWR: 'src--pwr',
  SD: 'src--sd',
  PROTO: 'src--proto',
};

/**
 * Log lines rendered at once.
 *
 * The store holds 1,500 entries and this rendered every one of them on every
 * EVT_LOG — four DOM nodes each, so ~6,000 nodes rebuilt per arriving log
 * line, on a device that emits them in bursts. The newest lines are the ones
 * being read (the body sticks to the bottom), so a tail window is what is
 * actually on screen; SHOW EARLIER grows it, and EXPORT has always written
 * every entry regardless of what is rendered.
 */
const WINDOW = 200;

export function LogViewer() {
  const entries = useLogStore((s) => s.entries);
  const paused = useLogStore((s) => s.paused);
  const filter = useLogStore((s) => s.filter);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [window_, setWindow] = useState(WINDOW);

  const visible = useMemo(() => filterEntries(entries, filter), [entries, filter]);
  const hidden = Math.max(0, visible.length - window_);
  const shown = useMemo(
    () => (hidden > 0 ? visible.slice(hidden) : visible),
    [visible, hidden],
  );

  // A narrowed filter can leave the window larger than it needs to be; that
  // is harmless, and resetting it would fight a reader who asked for more.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const exportLog = () => {
    const lines = visible.map((e) => `${formatLogTime(e.t)} ${e.src.padEnd(5)} ${e.msg}`);
    downloadText(`kino-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`, lines.join('\n'));
  };

  return (
    <div className="logviewer">
      <div className="logtools">
        <div className="logfilters" role="group" aria-label="Log source filter">
          {LOG_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className="logfilter"
              aria-pressed={filter === f}
              onClick={() => setLogFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <Button size="sm" variant={paused ? 'primary' : 'default'} onClick={() => setLogPaused(!paused)}>
            {paused ? 'RESUME' : 'PAUSE'}
          </Button>
          <Button size="sm" onClick={clearLogs}>
            CLEAR
          </Button>
          <Button size="sm" onClick={exportLog}>
            EXPORT
          </Button>
        </div>
      </div>
      <div ref={bodyRef} className="logbody" onScroll={onScroll} aria-live="off">
        {hidden > 0 ? (
          <div className="logline">
            <Button size="sm" onClick={() => setWindow(window_ + WINDOW)}>
              SHOW EARLIER
            </Button>{' '}
            <span className="faint">
              {hidden} earlier {hidden === 1 ? 'entry' : 'entries'} not rendered — EXPORT writes all{' '}
              {visible.length}
            </span>
          </div>
        ) : null}
        {visible.length === 0 ? (
          <span className="faint">— no entries{filter !== 'ALL' ? ` for ${filter}` : ''} —</span>
        ) : (
          shown.map((e, i) => (
            <div key={`${e.t}-${hidden + i}`} className="logline">
              <span className="t">{formatLogTime(e.t)}</span>{' '}
              <span className={`src ${SRC_CLASS[e.src] ?? ''}`}>{e.src.padEnd(5)}</span>
              {e.msg}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
