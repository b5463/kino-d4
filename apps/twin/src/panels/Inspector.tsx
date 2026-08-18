import { useState } from 'react';
import { netsFor, resolveDimensions } from '@kino/hardware-profiles';
import type { ComponentDef, HardwareProfile, NetDef, ResolvedDims } from '@kino/hardware-profiles';
import { useSceneStore } from '../state/sceneStore';
import { instanceTransforms } from '../scene/transforms';
import { ConfidenceBadge, formatSizeMm } from './ConfidenceBadge';

/** `21.0 × 17.8 × 15.0 mm` / `? × 55.0 × 73.0 mm` — an unknown axis is `?`, never a guessed number. */
export function formatDims(r: ResolvedDims): string {
  return `${formatSizeMm(r.sizeMm)} mm`;
}

/**
 * Other-endpoint instance ids for every net touching `instanceId` — used for
 * the "connected components" row. For D4_V1's `cam2` this is `["carrier",
 * "display"]` (its power/UART/sync nets), never `speaker` (no net touches it).
 */
export function connectedInstanceIds(profile: HardwareProfile, instanceId: string): string[] {
  const seen = new Set<string>();
  for (const net of netsFor(profile, instanceId)) {
    const other = net.from.instance === instanceId ? net.to.instance : net.from.instance;
    seen.add(other);
  }
  return [...seen];
}

/**
 * One net row as plain text (Task 15 owns making these clickable / wiring
 * `netFocus` — not this task, see the controller ruling). Direction reads
 * from `instanceId`'s side of the net: `CLASS pin → otherInstance` when this
 * instance is the `from` end, `CLASS pin ← otherInstance` when it's the `to` end.
 */
export function formatNetLine(net: NetDef, instanceId: string): string {
  const isFrom = net.from.instance === instanceId;
  const otherId = isFrom ? net.to.instance : net.from.instance;
  const pin = isFrom ? net.from.pin : net.to.pin;
  const arrow = isFrom ? '→' : '←';
  return `${net.cls} ${pin} ${arrow} ${otherId}`;
}

function formatVec3([x, y, z]: readonly [number, number, number]): string {
  return `${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`;
}

/**
 * FOV state for a component, straight from its profile `specs` — never a
 * hard-coded number (§7.3, §9). The camera node's `horizontalFovDeg`/
 * `verticalFovDeg` are `null` with `fovConfidence: "MEASURE_REQUIRED"`; that
 * honest state is what renders, not a plausible-looking guess. Returns
 * `null` when the component carries no FOV fields at all (i.e. it isn't a
 * camera/lens component).
 */
function fovLabel(component: ComponentDef): string | null {
  const specs = component.specs;
  if (!specs) return null;
  const h = specs['horizontalFovDeg'];
  const v = specs['verticalFovDeg'];
  const confidence = specs['fovConfidence'];
  if (h === undefined && v === undefined && confidence === undefined) return null;

  if (typeof h === 'number' && typeof v === 'number') {
    return `${h.toFixed(1)}° × ${v.toFixed(1)}°`;
  }
  return typeof confidence === 'string' && confidence === 'MEASURE_REQUIRED' ? 'MEASURE REQUIRED' : 'UNKNOWN';
}

/**
 * Right panel (§3/§8): every static/profile field for the selected instance.
 * Two things this task deliberately does NOT do (controller rulings, not
 * ambiguity left to resolve here):
 *  - the "simulated runtime state + firmware" block is a static `SIM OFF`
 *    placeholder — Task 18 wires it to `@kino/simulator-engine`'s live sim
 *    store, which this file never imports;
 *  - net rows are plain text, not clickable — Task 15 adds `netFocus` and
 *    the wiring-highlight click behavior.
 */
export function Inspector() {
  const profile = useSceneStore((s) => s.profile);
  const overrides = useSceneStore((s) => s.overrides);
  const selection = useSceneStore((s) => s.selection);
  const pitchMm = useSceneStore((s) => s.pitchMm);
  const explode = useSceneStore((s) => s.explode);
  const [faultOpen, setFaultOpen] = useState(false);

  if (!selection) {
    return <div className="twin-inspector twin-inspector--empty">Select a component to inspect.</div>;
  }

  const instance = profile.instances.find((i) => i.id === selection);
  if (!instance) {
    return <div className="twin-inspector twin-inspector--empty">Instance "{selection}" not found in profile.</div>;
  }

  const component = profile.components.find((c) => c.id === instance.component);
  if (!component) {
    return (
      <div className="twin-inspector twin-inspector--empty">
        Component "{instance.component}" missing from profile.
      </div>
    );
  }

  const override = overrides.find((o) => o.componentId === component.id);
  const resolved = resolveDimensions(component, override);
  const transform = instanceTransforms(profile, pitchMm, explode).get(instance.id);
  const nets = netsFor(profile, instance.id);
  const connected = connectedInstanceIds(profile, instance.id);
  const fov = fovLabel(component);
  const isCam = instance.group === 'camera-bar';

  return (
    <div className="twin-inspector">
      <div className="twin-inspector-header">
        <div className="twin-inspector-name">{component.name}</div>
        {component.model && <div className="twin-inspector-model">{component.model}</div>}
        <div className="twin-inspector-id">{instance.id}</div>
      </div>

      <section className="twin-inspector-section">
        <div className="twin-inspector-row">
          <span className="twin-inspector-label">DIMS</span>
          <span className="twin-inspector-value">{formatDims(resolved)}</span>
        </div>
        <ConfidenceBadge resolved={resolved} />
      </section>

      {fov && (
        <section className="twin-inspector-section">
          <div className="twin-inspector-row">
            <span className="twin-inspector-label">FOV</span>
            <span className="twin-inspector-value">{fov}</span>
          </div>
        </section>
      )}

      <section className="twin-inspector-section">
        <div className="twin-inspector-row">
          <span className="twin-inspector-label">POSITION</span>
          <span className="twin-inspector-value">{transform ? formatVec3(transform.positionMm) : '—'} mm</span>
        </div>
        <div className="twin-inspector-row">
          <span className="twin-inspector-label">ROTATION</span>
          <span className="twin-inspector-value">{transform ? formatVec3(transform.rotationDeg) : '—'} deg</span>
        </div>
      </section>

      <section className="twin-inspector-section">
        <div className="twin-inspector-label">MOUNTING HOLES</div>
        {override?.holesMm && override.holesMm.length > 0 ? (
          <ul className="twin-inspector-list">
            {override.holesMm.map(([x, y], i) => (
              <li key={i}>
                {x.toFixed(1)}, {y.toFixed(1)} mm
              </li>
            ))}
          </ul>
        ) : (
          <div className="twin-inspector-muted">not measured</div>
        )}
      </section>

      <section className="twin-inspector-section">
        <div className="twin-inspector-label">KEEPOUTS</div>
        {component.keepouts.length > 0 ? (
          <ul className="twin-inspector-list">
            {component.keepouts.map((k) => (
              <li key={k.id}>
                {k.label} — {formatSizeMm(k.sizeMm)} mm ({k.kind})
              </li>
            ))}
          </ul>
        ) : (
          <div className="twin-inspector-muted">none</div>
        )}
      </section>

      <section className="twin-inspector-section">
        <div className="twin-inspector-label">NETS</div>
        {nets.length > 0 ? (
          <ul className="twin-inspector-list">
            {nets.map((n) => (
              <li key={n.id}>{formatNetLine(n, instance.id)}</li>
            ))}
          </ul>
        ) : (
          <div className="twin-inspector-muted">none</div>
        )}
      </section>

      <section className="twin-inspector-section">
        <div className="twin-inspector-label">RUNTIME</div>
        <div className="twin-inspector-muted">SIM OFF</div>
      </section>

      <section className="twin-inspector-section">
        <div className="twin-inspector-label">CONNECTED</div>
        {connected.length > 0 ? (
          <div className="twin-inspector-chips">
            {connected.map((id) => (
              <span key={id} className="twin-chip">
                {id}
              </span>
            ))}
          </div>
        ) : (
          <div className="twin-inspector-muted">none</div>
        )}
      </section>

      {isCam && (
        <section className="twin-inspector-section">
          <button type="button" className="twin-btn twin-btn--fault" onClick={() => setFaultOpen((v) => !v)}>
            [INJECT FAULT]
          </button>
          {faultOpen && (
            <div className="twin-inspector-muted">Fault panel filtered to {instance.id} — not wired yet.</div>
          )}
        </section>
      )}
    </div>
  );
}
