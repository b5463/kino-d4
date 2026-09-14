import { Canvas } from '@react-three/fiber';
import { Stage } from './Stage';
import { SensorRig } from './SensorRig';

/**
 * The virtual sensors without the viewport.
 *
 * The SCREEN VIEW mounts no 3D scene, but the firmware's SHOOT screen and a
 * capture still need photographs, and those come from SensorRig rendering the
 * stage from each lens. This is the smallest canvas that can host it: the
 * stage (subjects, room, stage lights on the sensor layer) and the rig, in a
 * two-pixel element nobody can see, orbit, pick or reset. The rig renders
 * into its own render targets, so the canvas size is irrelevant to the
 * pictures; `frameloop="demand"` keeps R3F from drawing the tiny canvas at
 * 60 Hz for nothing.
 */
export function SensorStage() {
  return (
    <div className="twin-sensor-stage" aria-hidden="true">
      <Canvas frameloop="demand" camera={{ position: [0, 0, 1000], near: 1, far: 30000 }} gl={{ preserveDrawingBuffer: false }}>
        <Stage />
        <SensorRig />
      </Canvas>
    </div>
  );
}
