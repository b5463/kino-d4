import { useEffect, useRef } from 'react';
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

export function LogViewer() {
  const entries = useLogStore((s) => s.entries);
  const paused = useLogStore((s) => s.paused);
  const filter = useLogStore((s) => s.filter);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const visible = filterEntries(entries, filter);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

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
        {visible.length === 0 ? (
          <span className="faint">— no entries{filter !== 'ALL' ? ` for ${filter}` : ''} —</span>
        ) : (
          visible.map((e, i) => (
            <div key={`${e.t}-${i}`} className="logline">
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
