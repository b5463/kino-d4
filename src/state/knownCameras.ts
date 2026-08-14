// Cameras this browser has talked to, keyed by serial. Local only.

import { create } from 'zustand';
import type { DeviceInfo } from '../protocol/types';

export interface KnownCamera {
  serial: string;
  hardware: string;
  p4Firmware: string;
  lastSeen: number; // epoch ms
  demo: boolean;
}

const KEY = 'kino-studio.known-cameras';

function load(): KnownCamera[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as KnownCamera[];
  } catch {
    // Fresh profile or blocked storage.
  }
  return [];
}

export const useKnownCameras = create<{ cameras: KnownCamera[] }>(() => ({ cameras: load() }));

export function recordCamera(info: DeviceInfo, demo: boolean) {
  const cameras = useKnownCameras.getState().cameras.filter((c) => c.serial !== info.serial);
  cameras.unshift({
    serial: info.serial,
    hardware: info.hardware,
    p4Firmware: info.p4Firmware,
    lastSeen: Date.now(),
    demo,
  });
  const trimmed = cameras.slice(0, 8);
  useKnownCameras.setState({ cameras: trimmed });
  try {
    localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    // Storage full/blocked.
  }
}
