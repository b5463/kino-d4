import { useEffect } from 'react';
import { create } from 'zustand';
import type { DeviceInfo } from '@kino/kdp';
import { isSimulated } from '../../app/session';
import { downloadFirmwarePackage, listFirmwareReleases } from '../../firmware/catalog';
import type { CatalogRelease } from '../../firmware/catalog';
import { buildDemoPackage } from '../../firmware/demoPackage';
import { compareVersions } from '../../firmware/manifest';
import type { FwPackage } from '../../firmware/manifest';
import { useDeviceStore } from '../../state/deviceStore';

interface UpdateCheckState {
  /** Serial the check ran for; the check runs once per camera. */
  serial: string | null;
  available: CatalogRelease | null;
  /** "Not now" hides the row until the next connect. */
  dismissed: boolean;
}

export const useUpdateCheckStore = create<UpdateCheckState>(() => ({ serial: null, available: null, dismissed: false }));

/**
 * The newest compatible release that is newer than what the camera runs,
 * or null. Pure so the choice can be tested.
 */
export function newerRelease(releases: CatalogRelease[], info: DeviceInfo): CatalogRelease | null {
  const candidates = releases.filter((r) => r.compatible && compareVersions(r.release, info.p4Firmware) > 0);
  candidates.sort((a, b) => compareVersions(b.release, a.release));
  return candidates[0] ?? null;
}

export function dismissUpdate(): void {
  useUpdateCheckStore.setState({ dismissed: true });
}

/**
 * The silent check on connect. If the catalog is offline nothing is said;
 * if a newer compatible release exists it becomes an attention row.
 */
export function useUpdateCheck(): void {
  const info = useDeviceStore((s) => s.info);
  useEffect(() => {
    if (!info) return;
    if (useUpdateCheckStore.getState().serial === info.serial) return;
    useUpdateCheckStore.setState({ serial: info.serial, available: null, dismissed: false });
    let cancelled = false;
    if (simulatedUpdateWanted()) {
      void buildDemoPackage().then((pkg) => {
        if (cancelled) return;
        useUpdateCheckStore.setState({ available: demoRelease(pkg) });
      });
      return () => {
        cancelled = true;
      };
    }
    void listFirmwareReleases(info.hardware, info.protocol).then((result) => {
      if (cancelled || !result.ok) return;
      useUpdateCheckStore.setState({ available: newerRelease(result.value, info) });
    });
    return () => {
      cancelled = true;
    };
  }, [info]);
}

/** The channel name a simulated release carries, so the flow knows not to download it. */
export const DEMO_CHANNEL = 'simulated';

/**
 * A development-only way to walk the update against the simulated camera:
 * `?simUpdate=1` on a dev build with a simulated link offers the in-memory
 * demo package as if the catalog had published it. The state machine
 * underneath is the real one; only the download is skipped. Never on a
 * real camera, never in a production build.
 */
function simulatedUpdateWanted(): boolean {
  if (!import.meta.env.DEV || typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('simUpdate') && isSimulated();
}

function demoRelease(pkg: FwPackage): CatalogRelease {
  const m = pkg.manifest;
  return {
    manifest: {} as CatalogRelease['manifest'],
    release: m.version,
    channel: DEMO_CHANNEL,
    publishedAt: new Date().toISOString(),
    compatible: true,
    reasons: [],
    notes: m.releaseNotes ?? null,
  };
}

/** The package for a release: the demo package in memory, or a download. */
export async function packageFor(release: CatalogRelease): Promise<{ ok: true; value: FwPackage } | { ok: false; error: string }> {
  if (release.channel === DEMO_CHANNEL) return { ok: true, value: await buildDemoPackage() };
  return downloadFirmwarePackage(release.release, release.channel);
}
