export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadText(name: string, text: string): void {
  downloadBlob(name, new Blob([text], { type: 'text/plain;charset=utf-8' }));
}
