export { twinMaterials, XRAY_OPACITY, KEEPOUT_OPACITY, type TwinMaterials, type WireColor } from './materials';

export {
  buildComponentObject,
  applyVisualMode,
  fallbackBoxMm,
  type BuildOpts,
  type VisualMode,
} from './builders';

export {
  attachComponentMesh,
  clearComponentMeshes,
  fitMeshToBox,
  glbProvider,
  hasComponentMesh,
  registerComponentMesh,
  type MeshProvider,
  stlProvider,
} from './tierA';
