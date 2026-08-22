// The virtual bench stage (issue #72): placeable subjects, an optional room
// shell, and controllable stage lighting, all in front of the D4 on +Z.
// Everything here lives on layer 0 (visible in the viewport) AND the sensor
// layer (photographed by the virtual cameras).
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useStageStore, kelvinToHex, selectSubject, removeSubject, STAGE_FLOOR_Y_MM } from '../state/stageStore';
import type { StageSubject } from '../state/stageStore';
import { buildSubject } from './subjects';
import { SENSOR_LAYER } from './sensor';

function enableSensorLayer(obj: THREE.Object3D | null): void {
  obj?.layers.enable(SENSOR_LAYER);
}

function SubjectNode({ subject, selected }: { subject: StageSubject; selected: boolean }) {
  const object = useMemo(() => buildSubject(subject.kind), [subject.kind]);
  useEffect(() => () => {
    object.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      }
    });
  }, [object]);

  return (
    <group
      position={[subject.xMm, subject.yMm, subject.zMm]}
      rotation={[0, (subject.rotationDeg * Math.PI) / 180, 0]}
      scale={subject.scale}
      onClick={(e) => {
        e.stopPropagation();
        selectSubject(subject.id);
      }}
    >
      <primitive object={object} />
      {selected ? (
        <mesh position={[0, -subject.yMm + STAGE_FLOOR_Y_MM + 4, 0]} rotation={[-Math.PI / 2, 0, 0]} raycast={() => {}}>
          <ringGeometry args={[360, 400, 32]} />
          <meshBasicMaterial color="#4aa8a1" transparent opacity={0.6} side={THREE.DoubleSide} />
        </mesh>
      ) : null}
    </group>
  );
}

/** Room shell for the party scene: floor, back wall, side walls — matte,
 * warm-dark, enough depth for background subjects and backlighting. */
function Room() {
  return (
    <group>
      <mesh position={[0, STAGE_FLOOR_Y_MM, 1750]} rotation={[-Math.PI / 2, 0, 0]} ref={enableSensorLayer}>
        <planeGeometry args={[7000, 5500]} />
        <meshStandardMaterial color="#2b2320" roughness={0.95} />
      </mesh>
      <mesh position={[0, 550, 4500]} rotation={[0, Math.PI, 0]} ref={enableSensorLayer}>
        <planeGeometry args={[7000, 3500]} />
        <meshStandardMaterial color="#38302c" roughness={0.95} />
      </mesh>
      <mesh position={[-3500, 550, 1750]} rotation={[0, Math.PI / 2, 0]} ref={enableSensorLayer}>
        <planeGeometry args={[5500, 3500]} />
        <meshStandardMaterial color="#332b28" roughness={0.95} />
      </mesh>
      <mesh position={[3500, 550, 1750]} rotation={[0, -Math.PI / 2, 0]} ref={enableSensorLayer}>
        <planeGeometry args={[5500, 3500]} />
        <meshStandardMaterial color="#302a26" roughness={0.95} />
      </mesh>
    </group>
  );
}

export function Stage() {
  const subjects = useStageStore((s) => s.subjects);
  const selectedId = useStageStore((s) => s.selectedId);
  const lighting = useStageStore((s) => s.lighting);
  const room = useStageStore((s) => s.room);
  const ambientColor = kelvinToHex(lighting.colorK);

  // Delete/Backspace removes the selected subject — the fast way to clear a
  // scene. Ignored while a form control has focus so typing stays safe.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
      const selected = useStageStore.getState().selectedId;
      if (selected) {
        event.preventDefault();
        removeSubject(selected);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <group>
      {/* Stage lights carry the sensor layer so the virtual cameras see the
          same illumination the viewport does. The assembly's own inspection
          lights stay layer-0 only — they never light a photograph. */}
      <ambientLight intensity={lighting.ambient} color={ambientColor} ref={enableSensorLayer} />
      <directionalLight position={[-1400, 900, 600]} intensity={lighting.key} color={ambientColor} ref={enableSensorLayer} />
      <directionalLight position={[400, 700, 3800]} intensity={lighting.back} color="#cdd6ff" ref={enableSensorLayer} />
      {room ? <Room /> : null}
      {subjects.map((subject) => (
        <SubjectNode key={subject.id} subject={subject} selected={subject.id === selectedId} />
      ))}
    </group>
  );
}
