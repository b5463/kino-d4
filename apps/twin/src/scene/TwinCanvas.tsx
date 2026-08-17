import type { ReactNode } from 'react';
import { Canvas } from '@react-three/fiber';
import { useSceneStore } from '../state/sceneStore';

interface TwinCanvasProps {
  children?: ReactNode;
}

/**
 * The R3F canvas root. Camera start pose is a fixed scene-wide constant
 * (§3); `gl.preserveDrawingBuffer` keeps the backbuffer around for Task 21's
 * screenshot export. Clicking empty space (no instance hit) clears
 * selection — the natural complement to Assembly's per-instance onClick.
 */
export function TwinCanvas({ children }: TwinCanvasProps) {
  return (
    <Canvas
      camera={{ position: [180, 120, 220], near: 1, far: 5000 }}
      gl={{ preserveDrawingBuffer: true }}
      onPointerMissed={() => useSceneStore.getState().select(null)}
    >
      {children}
    </Canvas>
  );
}
