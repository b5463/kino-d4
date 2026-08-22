import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import { resolveDimensions } from '@kino/hardware-profiles';
import type { ComponentDef, InstanceDef, MeasuredOverride, ResolvedDims } from '@kino/hardware-profiles';
import {
  ENCLOSURE_PANEL_THICKNESS_MM,
  applyVisualMode,
  attachComponentMesh,
  buildAcrylicPanel,
  buildComponentObject,
  fallbackBoxMm,
  hasComponentMesh,
} from '@kino/three-assets';
import type { VisualMode } from '@kino/three-assets';
import { useSceneStore, setHovered } from '../state/sceneStore';
import type { ViewMode } from '../state/sceneStore';
import { instanceTransforms, type InstanceTransform } from './transforms';

// §7 construction note on the enclosure-shell component: "2-3mm clear acrylic
// panels". The profile only carries the full 126x80x36 envelope as one
// dimension claim; the illustrative panel thickness lives in three-assets
// (shared with the skeleton frame's inset so the two can never drift apart).
const PANEL_THICKNESS_MM = ENCLOSURE_PANEL_THICKNESS_MM;

function degToRadTuple([x, y, z]: [number, number, number]): [number, number, number] {
  return [THREE.MathUtils.degToRad(x), THREE.MathUtils.degToRad(y), THREE.MathUtils.degToRad(z)];
}

/**
 * Combines the view mode, the per-instance visibility checkbox, and
 * selection/hover into the single `VisualMode` `applyVisualMode` expects.
 * Priority: hidden (checkbox off, or this view mode hides this instance's
 * group) beats everything else; then selected > highlight-on-hover > the
 * mode's own default.
 */
export function visualModeFor(params: {
  isShell: boolean;
  storeVisible: boolean;
  viewMode: ViewMode;
  isSelected: boolean;
  isHovered: boolean;
}): VisualMode {
  const { isShell, storeVisible, viewMode, isSelected, isHovered } = params;
  if (!storeVisible) return 'hidden';
  if (viewMode === 'internals' && isShell) return 'hidden';
  if (viewMode === 'enclosure' && !isShell) return 'hidden';
  if (isSelected) return 'selected';
  if (isHovered) return 'highlight';
  if (viewMode === 'xray' || viewMode === 'wiring') return 'xray';
  return 'normal';
}

interface InstanceNodeProps {
  instance: InstanceDef;
  component: ComponentDef;
  override: MeasuredOverride | undefined;
  transform: InstanceTransform;
  visualMode: VisualMode;
}

function InstanceNode({ instance, component, override, transform, visualMode }: InstanceNodeProps) {
  // Resolved dims only change identity when the override for this
  // component changes — component/instance references are stable for the
  // life of the static D4_V1 profile.
  const resolved = useMemo<ResolvedDims>(() => resolveDimensions(component, override), [component, override]);

  // The enclosure is two components (audit #63): the chassis skeleton frame
  // (built by buildComponentObject, as any other component) and the
  // front/rear acrylic shell panels, thin plates built separately by
  // buildAcrylicPanel — never rebuilt on every explode/pitch tick, only
  // when overrides touch this component (§ three-assets builders).
  const object = useMemo(() => {
    const isAcrylicPanel = component.id === 'enclosure-shell';
    if (isAcrylicPanel) {
      const [w, h] = fallbackBoxMm(resolved.sizeMm);
      return buildAcrylicPanel([w, h, PANEL_THICKNESS_MM], instance.id);
    }
    return buildComponentObject(component, { resolved, instanceId: instance.id });
  }, [component, instance.id, resolved]);

  // Read inside the async swap below so a late-arriving mesh is painted in
  // the mode showing right now, without the swap re-running on every hover.
  const visualModeRef = useRef(visualMode);
  visualModeRef.current = visualMode;

  // Tier A (issue #30): a registered converted CAD mesh replaces the proxy
  // body once it loads, fitted to the resolved dimensions — clearance, the
  // BOM and the inspector keep reading the profile's numbers. No
  // registration, a failed load, or an unmounted node leaves the proxy.
  useEffect(() => {
    if (!hasComponentMesh(component.id)) return;
    let live = true;
    const [w, h, d] = fallbackBoxMm(resolved.sizeMm);
    void attachComponentMesh(object, component.id, [w, h, d]).then((swapped) => {
      if (swapped && live) applyVisualMode(object, visualModeRef.current);
    });
    return () => {
      live = false;
    };
  }, [object, component.id, resolved]);

  applyVisualMode(object, visualMode);

  const rotation = useMemo(() => degToRadTuple(transform.rotationDeg), [transform.rotationDeg]);

  return (
    <primitive
      object={object}
      position={transform.positionMm}
      rotation={rotation}
      onPointerOver={(e: ThreeEvent<PointerEvent>) => {
        // A "hidden" instance (checkbox off, or this view mode hides its
        // group) must let the pointer pass through to whatever is actually
        // visible behind it — returning without stopPropagation() does
        // exactly that (R3F keeps walking to the next-nearest hit).
        if (!object.visible) return;
        e.stopPropagation();
        setHovered(instance.id);
      }}
      onPointerOut={(e: ThreeEvent<PointerEvent>) => {
        if (!object.visible) return;
        e.stopPropagation();
        if (useSceneStore.getState().hovered === instance.id) setHovered(null);
      }}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        if (!object.visible) return;
        e.stopPropagation();
        useSceneStore.getState().select(instance.id);
      }}
    />
  );
}

/**
 * The assembly: every profile instance, positioned by `instanceTransforms`
 * and shaded by the current view mode/selection. Three units = millimetres
 * throughout, matching the profile's own axes/origin (§4).
 */
export function Assembly() {
  const profile = useSceneStore((s) => s.profile);
  const overrides = useSceneStore((s) => s.overrides);
  const pitchMm = useSceneStore((s) => s.pitchMm);
  const explode = useSceneStore((s) => s.explode);
  const viewMode = useSceneStore((s) => s.viewMode);
  const selection = useSceneStore((s) => s.selection);
  const hovered = useSceneStore((s) => s.hovered);
  const visibility = useSceneStore((s) => s.visibility);
  const showGrid = useSceneStore((s) => s.showGrid);

  const transforms = useMemo(() => instanceTransforms(profile, pitchMm, explode), [profile, pitchMm, explode]);

  const componentById = useMemo(() => {
    const map = new Map<string, ComponentDef>();
    for (const c of profile.components) map.set(c.id, c);
    return map;
  }, [profile]);

  const overrideByComponentId = useMemo(() => {
    const map = new Map<string, MeasuredOverride>();
    for (const o of overrides) map.set(o.componentId, o);
    return map;
  }, [overrides]);

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[200, 300, 200]} intensity={0.8} />
      <directionalLight position={[-200, 150, -150]} intensity={0.35} />
      {showGrid && <gridHelper args={[300, 30]} />}

      {profile.instances.map((instance) => {
        const component = componentById.get(instance.component);
        const transform = transforms.get(instance.id);
        if (!component || !transform) return null; // defensive: profile data should always resolve both

        const visualMode = visualModeFor({
          isShell: instance.group === 'shell',
          storeVisible: visibility[instance.id] ?? true,
          viewMode,
          isSelected: selection === instance.id,
          isHovered: hovered === instance.id,
        });

        return (
          <InstanceNode
            key={instance.id}
            instance={instance}
            component={component}
            override={overrideByComponentId.get(instance.component)}
            transform={transform}
            visualMode={visualMode}
          />
        );
      })}
    </>
  );
}
