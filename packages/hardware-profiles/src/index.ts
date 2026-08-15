import { parseVersioned } from '@kino/schemas';
import { hardwareProfile } from './types';
import raw from './profiles/d4-v1.json';

export const D4_V1 = parseVersioned(hardwareProfile, raw);

export {
  hardwareProfile,
  SOURCE_KINDS,
  PROVENANCE_TAGS,
  type HardwareProfile,
  type ComponentDef,
  type DimensionSource,
  type SourceKind,
  type InstanceDef,
  type KeepoutDef,
  type PowerProfile,
  type ProvenanceTag,
} from './types';
