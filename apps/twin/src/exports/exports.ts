import { z } from 'zod';
import type { WebGLRenderer } from 'three';
import { defineSchema } from '@kino/schemas';
import { resolveDimensions } from '@kino/hardware-profiles';
import type { HardwareProfile, MeasuredOverride } from '@kino/hardware-profiles';
import type { CollisionFinding } from '../collision/collide';
import { instanceTransforms } from '../scene/transforms';

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

// Geometry only, deliberately: sceneStore's powerProfileId (experimental
// bench pack) is NOT serialized here — a layout file must not smuggle a
// non-production power selection past the POWER panel's banner (audit #63).
export const sceneLayoutDoc = defineSchema({
  schema: 'kino.twin-scene-layout',
  version: 1,
  shape: z.object({
    schema: z.literal('kino.twin-scene-layout'),
    version: z.literal(1),
    profile: z.string(),
    pitchMm: z.number(),
    explode: z.number(),
    transforms: z.array(z.object({ id: z.string(), positionMm: vec3, rotationDeg: vec3 })),
  }),
  migrations: {},
});

type LayoutInput = Pick<
  { profile: HardwareProfile; pitchMm: number; explode: number },
  'profile' | 'pitchMm' | 'explode'
>;

export function exportSceneLayout(state: LayoutInput): string {
  const transforms = [...instanceTransforms(state.profile, state.pitchMm, state.explode)].map(([id, transform]) => ({
    id,
    ...transform,
  }));
  return JSON.stringify({
    schema: 'kino.twin-scene-layout',
    version: 1,
    profile: state.profile.profile,
    pitchMm: state.pitchMm,
    explode: state.explode,
    transforms,
  }, null, 2);
}

export function exportBom(profile: HardwareProfile, overrides: MeasuredOverride[]): string {
  return JSON.stringify({
    schema: 'kino.twin-bom',
    version: 1,
    profile: profile.profile,
    components: profile.components.map((component) => {
      const override = overrides.find((item) => item.componentId === component.id);
      const resolved = resolveDimensions(component, override);
      return {
        id: component.id,
        name: component.name,
        ...(component.model ? { model: component.model } : {}),
        qty: component.qty,
        dimensionsMm: resolved.sizeMm,
        confidence: resolved.confidence,
        measureToLock: resolved.measureToLock,
        meshTier: component.meshTier,
        specs: component.specs ?? {},
      };
    }),
  }, null, 2);
}

function dimensions(value: readonly (number | null)[]): string {
  return value.map((axis) => axis === null ? '?' : axis.toFixed(1)).join(' × ');
}

export function exportDimensionReport(profile: HardwareProfile, overrides: MeasuredOverride[]): string {
  const header = 'component | dimensions mm | confidence | lock';
  const rows = profile.components.map((component) => {
    const resolved = resolveDimensions(component, overrides.find((item) => item.componentId === component.id));
    return `${component.name} | ${dimensions(resolved.sizeMm)} | ${resolved.confidence} | ${resolved.measureToLock ? 'MEASURE TO LOCK' : 'LOCKED'}`;
  });
  return [header, ...rows].join('\n') + '\n';
}

export function exportCollisionReport(findings: CollisionFinding[]): string {
  return ['kind | a | b | distance mm', ...findings.map((finding) =>
    `${finding.kind} | ${finding.a} | ${finding.b} | ${finding.distanceMm.toFixed(4)}`,
  )].join('\n') + '\n';
}

export function exportWiringReport(profile: HardwareProfile): string {
  return ['id | class | route | gauge | color', ...profile.nets.map((net) =>
    `${net.id} | ${net.cls} | ${net.from.instance}:${net.from.pin} → ${net.to.instance}:${net.to.pin} | ${net.gauge} | ${net.color}`,
  )].join('\n') + '\n';
}

export function screenshotPng(gl: WebGLRenderer): Promise<Blob> {
  return new Promise((resolve, reject) => {
    gl.domElement.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG screenshot creation failed')), 'image/png');
  });
}
