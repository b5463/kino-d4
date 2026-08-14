export async function sha256Hex(data: Uint8Array): Promise<string> {
  const copy = new Uint8Array(data); // detach from any larger backing buffer
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
