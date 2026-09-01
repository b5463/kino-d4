// Tethered capture: while enabled, every capture the camera commits is
// pulled to this computer automatically. With the File System Access API a
// target folder is written directly (one subfolder per capture, like the
// SD card layout); otherwise each file goes through normal downloads.

import { create } from 'zustand';
import { getDevice, onCaptureEvent } from '../app/session';
import { downloadCaptureSet, TransferHandle } from './media';
import { downloadText } from '../utils/download';

interface TetherState {
  enabled: boolean;
  /** Folder name when using FS Access, or 'Downloads' fallback. */
  target: string | null;
  saving: string | null; // capture id currently transferring
  savedCount: number;
  lastError: string | null;
  /**
   * The last capture written whose bytes nothing could check, and how many of
   * its files that was. Not an error — the files are on disk and the transfer
   * ran to the declared length — but shipped firmware sends no per-file
   * SHA-256 (contract D20), so saying "SAVED" alone would claim a check that
   * did not happen.
   */
  lastUnverified: string | null;
}

export const useTetherStore = create<TetherState>(() => ({
  enabled: false,
  target: null,
  saving: null,
  savedCount: 0,
  lastError: null,
  lastUnverified: null,
}));

let dirHandle: FileSystemDirectoryHandle | null = null;
let queue = Promise.resolve();

export async function startTether(): Promise<void> {
  if ('showDirectoryPicker' in window) {
    try {
      dirHandle = await window.showDirectoryPicker({ id: 'kino-tether', mode: 'readwrite' });
    } catch {
      return; // picker dismissed
    }
    useTetherStore.setState({ enabled: true, target: dirHandle.name, lastError: null, lastUnverified: null });
  } else {
    dirHandle = null;
    useTetherStore.setState({ enabled: true, target: 'Downloads', lastError: null, lastUnverified: null });
  }
}

export function stopTether(): void {
  dirHandle = null;
  useTetherStore.setState({ enabled: false, target: null, saving: null, lastUnverified: null });
}

async function writeToFolder(captureId: string, files: { name: string; data: Uint8Array }[], metaJson: string) {
  if (!dirHandle) throw new Error('No target folder');
  const sub = await dirHandle.getDirectoryHandle(captureId, { create: true });
  for (const file of files) {
    const handle = await sub.getFileHandle(file.name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(file.data as unknown as FileSystemWriteChunkType);
    await writable.close();
  }
  const metaHandle = await sub.getFileHandle('META.JSON', { create: true });
  const metaWritable = await metaHandle.createWritable();
  await metaWritable.write(metaJson);
  await metaWritable.close();
}

function saveViaDownloads(captureId: string, files: { name: string; data: Uint8Array }[], metaJson: string) {
  for (const file of files) {
    const url = URL.createObjectURL(new Blob([file.data as BlobPart], { type: 'image/jpeg' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${captureId}_${file.name}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  downloadText(`${captureId}_META.JSON`, metaJson, 'application/json');
}

async function pullCapture(id: string) {
  const dev = getDevice();
  if (!dev) return;
  useTetherStore.setState({ saving: id });
  try {
    const info = await dev.mediaInfo(id);
    const files = await downloadCaptureSet(dev, info, new TransferHandle());
    const metaJson = JSON.stringify(info, null, 2);
    if (dirHandle) await writeToFolder(id, files, metaJson);
    else saveViaDownloads(id, files, metaJson);
    const unchecked = files.filter((f) => !f.verified).length;
    useTetherStore.setState((s) => ({
      saving: null,
      savedCount: s.savedCount + 1,
      lastError: null,
      lastUnverified:
        unchecked > 0
          ? `${id}: ${unchecked} of ${files.length} file(s) written unverified — the camera sent no SHA-256`
          : null,
    }));
  } catch (err) {
    useTetherStore.setState({
      saving: null,
      lastError: `${id}: ${err instanceof Error ? err.message : String(err)}`,
      lastUnverified: null,
    });
  }
}

// One module-level subscription; captures queue so parallel shots transfer
// in order without contending for the serial link.
onCaptureEvent((e) => {
  if (!useTetherStore.getState().enabled) return;
  queue = queue.then(() => pullCapture(e.id));
});
