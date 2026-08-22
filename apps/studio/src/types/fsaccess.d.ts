// File System Access API pieces not yet in lib.dom (Chromium-only).

interface Window {
  showDirectoryPicker(options?: { id?: string; mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
}

interface FileSystemDirectoryHandle {
  // Directory iteration lives in lib.dom.asynciterable, which this app's
  // `lib` list does not pull in.
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}
