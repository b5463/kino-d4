import { useSceneStore } from '../state/sceneStore';
import type { HardwareProfile, InstanceDef } from '@kino/hardware-profiles';

export interface InstanceGroup {
  label: string;
  instances: InstanceDef[];
}

/** §3 left-panel grouping order — fixed, not alphabetical, so the camera bar always leads. */
const GROUP_ORDER: Array<{ key: InstanceDef['group']; label: string }> = [
  { key: 'camera-bar', label: 'CAMERA BAR' },
  { key: 'body', label: 'BODY' },
  { key: 'power', label: 'POWER' },
  { key: 'shell', label: 'SHELL' },
];

/**
 * Splits `profile.instances` into the four §3 tree groups, in a fixed
 * display order, dropping any group the profile has no instances for. Pure
 * and profile-parametric (§25) — a future profile only needs its instances
 * to carry the right `group` tag, not any particular id naming.
 */
export function groupedInstances(profile: HardwareProfile): InstanceGroup[] {
  return GROUP_ORDER.map(({ key, label }) => ({
    label,
    instances: profile.instances.filter((inst) => inst.group === key),
  })).filter((g) => g.instances.length > 0);
}

/**
 * Left panel (§3): every instance, grouped, with a visibility checkbox and a
 * select button. Selecting drives `Inspector.tsx`; visibility is scene-only
 * (Task 12's `Assembly` reads it to hide/show meshes) and does not affect
 * selection.
 */
export function ComponentTree() {
  const profile = useSceneStore((s) => s.profile);
  const selection = useSceneStore((s) => s.selection);
  const select = useSceneStore((s) => s.select);
  const visibility = useSceneStore((s) => s.visibility);
  const toggleVisible = useSceneStore((s) => s.toggleVisible);

  const groups = groupedInstances(profile);

  return (
    <div className="twin-tree" role="tree" aria-label="Component tree">
      <div className="twin-tree-head">
        <span className="twin-tree-title">PARTS</span>
        <span className="twin-tree-hint">Click a part to inspect it. Untick to hide it in 3D.</span>
      </div>
      {groups.map((group) => (
        <div key={group.label} className="twin-tree-group">
          <div className="twin-tree-group-label">{group.label}</div>
          {group.instances.map((inst) => {
            const visible = visibility[inst.id] ?? true;
            const isSelected = selection === inst.id;
            const component = profile.components.find((c) => c.id === inst.component);

            return (
              <div
                key={inst.id}
                className={isSelected ? 'twin-tree-row twin-tree-row--selected' : 'twin-tree-row'}
                role="treeitem"
                aria-selected={isSelected}
              >
                <input
                  type="checkbox"
                  className="twin-tree-visibility"
                  checked={visible}
                  onChange={() => toggleVisible(inst.id)}
                  aria-label={`Toggle ${inst.id} visibility`}
                />
                <button type="button" className="twin-tree-label" onClick={() => select(inst.id)}>
                  {component?.name ?? inst.id}
                  <span className="twin-tree-id">{inst.id}</span>
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
