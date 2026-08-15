import { useEffect, useState } from 'react';
import { SCENARIO_LIST } from '@kino/test-fixtures';
import { getDemoDevice } from '../app/session';

// Simulator-only fault injection. Rendered exclusively when the session is
// on the mock transport — with real hardware this panel does not exist.
export function DebugPanel() {
  const [open, setOpen] = useState(false);
  const [, bump] = useState(0);
  const device = getDemoDevice();

  useEffect(() => {
    device?.onScenarioChange(() => bump((n) => n + 1));
  }, [device]);

  if (!device) return null;

  return (
    <div className="debugpanel">
      <button
        type="button"
        className="debugpanel-head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="sim-faults-body"
      >
        <span className="microlabel">SIMULATOR FAULTS</span>
        <span className="microlabel">{open ? '▾' : '▴'}</span>
      </button>
      {open ? (
        <div className="debugpanel-body" id="sim-faults-body">
          {SCENARIO_LIST.map((s) => {
            const active = device.scenarios[s.key];
            return (
              <button
                key={s.key}
                type="button"
                className="debugtoggle"
                aria-pressed={active}
                onClick={() => device.setScenario(s.key, !active)}
              >
                <span>{s.label}</span>
                <span className="state">{active ? (s.oneShot ? 'ARMED' : 'ON') : 'OFF'}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
