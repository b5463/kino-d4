export { twinMaterials, XRAY_OPACITY, KEEPOUT_OPACITY, type TwinMaterials, type WireColor } from './materials';

export {
  buildComponentObject,
  buildAcrylicPanel,
  applyVisualMode,
  fallbackBoxMm,
  ENCLOSURE_PANEL_THICKNESS_MM,
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
} from './tierA';
