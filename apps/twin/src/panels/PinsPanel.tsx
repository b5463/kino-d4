import { useSceneStore } from '../state/sceneStore';

interface Header2x13 {
  note?: string;
  left: string[];
  right: string[];
}

/**
 * Connector/pin inspection (audit #63) — the first scene consumer of the
 * profile's gpio map, JP1 header table and XIAO DVP pin map. Everything
 * here is data-driven from the hardware profile. The header is drawn as the
 * manufacturer prints it: row i carries pin 2i+1 on the left and 2i+2 on the
 * right. KINO functions come from the jp1 map by physical pin, so a signal
 * shows up on the pin the firmware's BOARD_*_JP1 macro names, not on a GPIO
 * string match. Assignments are PROVISIONAL until bench validation (issue #2).
 */
export function PinsPanel() {
  const profile = useSceneStore((s) => s.profile);

  const display = profile.components.find((c) => c.id === 'main-display');
  const header = (display?.specs as Record<string, unknown> | undefined)?.header2x13 as Header2x13 | undefined;
  const camera = profile.components.find((c) => c.id === 'camera-node');
  const dvp = (camera?.specs as Record<string, unknown> | undefined)?.dvpPinMap as Record<string, string> | undefined;
  const jp1 = profile.jp1;

  // physical pin → KINO function, from the jp1 map. Profiles without a jp1
  // map fall back to matching the header net name against the gpio map.
  const functionByPin = new Map<number, string>();
  const functionByNet = new Map<string, string>();
  if (jp1) {
    for (const [fn, slot] of Object.entries(jp1.pins)) functionByPin.set(slot.pin, fn);
  } else {
    for (const [fn, pin] of Object.entries(profile.gpio)) {
      if (typeof pin === 'string' && pin.startsWith('GPIO')) functionByNet.set(pin, fn);
    }
  }
  const reservedByPin = new Map<number, string>();
  for (const r of jp1?.reserved ?? []) reservedByPin.set(r.pin, r.use);

  const fnFor = (pin: number, net: string) => functionByPin.get(pin) ?? functionByNet.get(net) ?? '';
  const isReserved = (pin: number, net: string) =>
    reservedByPin.has(pin) || net.startsWith('C6_') || net.startsWith('ESI2C_');
  const cell = (pin: number, net: string) => (
    <td className={isReserved(pin, net) ? 'twin-pins-reserved' : ''} title={reservedByPin.get(pin)}>
      {net}
    </td>
  );

  return (
    <section className="twin-tool-panel" aria-label="Pins and connectors">
      <div className="twin-panel-heading"><span>PINS</span><span>PROVISIONAL</span></div>

      {header ? (
        <div className="twin-panel-section">
          <table className="twin-pins-table">
            <thead>
              <tr><th>PIN</th><th>LEFT</th><th>KINO</th><th>RIGHT</th><th>KINO</th><th>PIN</th></tr>
            </thead>
            <tbody>
              {header.left.map((left, i) => {
                const right = header.right[i] ?? '';
                const leftPin = 2 * i + 1;
                const rightPin = 2 * i + 2;
                return (
                  <tr key={leftPin}>
                    <td className="twin-pins-num">{leftPin}</td>
                    {cell(leftPin, left)}
                    <td className="twin-pins-fn">{fnFor(leftPin, left)}</td>
                    {cell(rightPin, right)}
                    <td className="twin-pins-fn">{fnFor(rightPin, right)}</td>
                    <td className="twin-pins-num">{rightPin}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="twin-panel-note">
            {jp1 ? `${jp1.header}, ` : ''}2×13 header, pin numbers as printed. Greyed pins are reserved (TOUCH_RESET,
            LCD_RESET, ESI2C, C6) and never repurposed. Assignments lock only after electrical validation on
            the physical board.
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
