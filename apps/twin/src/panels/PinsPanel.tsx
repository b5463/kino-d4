import { useSceneStore } from '../state/sceneStore';

interface Header2x13 {
  note?: string;
  left: string[];
  right: string[];
}

/**
 * Connector/pin inspection (audit #63) — the first scene consumer of the
 * profile's gpio map, 2×13 header table and XIAO DVP pin map. Everything
 * here is data-driven from the hardware profile; assignments are PROVISIONAL
 * until bench validation (issue #2) and say so.
 */
export function PinsPanel() {
  const profile = useSceneStore((s) => s.profile);

  const display = profile.components.find((c) => c.id === 'main-display');
  const header = (display?.specs as Record<string, unknown> | undefined)?.header2x13 as Header2x13 | undefined;
  const camera = profile.components.find((c) => c.id === 'camera-node');
  const dvp = (camera?.specs as Record<string, unknown> | undefined)?.dvpPinMap as Record<string, string> | undefined;

  // pin name → KINO function, inverted from the gpio map so the header table
  // can annotate its physical rows.
  const functionByPin = new Map<string, string>();
  for (const [fn, pin] of Object.entries(profile.gpio)) {
    if (typeof pin === 'string' && pin.startsWith('GPIO')) functionByPin.set(pin, fn);
  }

  return (
    <section className="twin-tool-panel" aria-label="Pins and connectors">
      <div className="twin-panel-heading"><span>PINS</span><span>PROVISIONAL</span></div>

      {header ? (
        <div className="twin-panel-section">
          <table className="twin-pins-table">
            <thead>
              <tr><th>LEFT</th><th>KINO</th><th>RIGHT</th><th>KINO</th></tr>
            </thead>
            <tbody>
              {header.left.map((left, i) => {
                const right = header.right[i] ?? '';
                return (
                  <tr key={left + right + i}>
                    <td>{left}</td>
                    <td className="twin-pins-fn">{functionByPin.get(left) ?? ''}</td>
                    <td className={right.startsWith('C6') || right === 'ESP_3V3' ? 'twin-pins-reserved' : ''}>{right}</td>
                    <td className="twin-pins-fn">{functionByPin.get(right) ?? ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="twin-panel-note">
            2×13 header. C6/ESP_3V3 pins are reserved and never repurposed. Assignments lock only after
            electrical validation on the physical board.
          </p>
        </div>
      ) : (
        <p className="twin-panel-empty">This profile carries no header table.</p>
      )}

      {dvp ? (
        <div className="twin-panel-section">
          <table className="twin-pins-table">
            <thead>
              <tr><th>DVP SIGNAL</th><th>XIAO PIN</th></tr>
            </thead>
            <tbody>
              {Object.entries(dvp)
                .filter(([signal]) => signal !== 'note')
                .map(([signal, pin]) => (
                  <tr key={signal}>
                    <td>{signal}</td>
                    <td>{pin}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <p className="twin-panel-note">
            XIAO ESP32-S3 Sense camera interface, OFFICIAL_SPEC. The OV5640 AF module must match it; AFVDD is
            2.8 V, never 3.3 V.
          </p>
        </div>
      ) : null}
    </section>
  );
}
