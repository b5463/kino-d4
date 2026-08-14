// Studio-side sound engine. The KINO body synthesizes its builtin sounds in
// firmware; this file recreates them with Web Audio so Studio can preview
// them without hardware, plays uploaded clips, and converts user audio files
// to the device storage format (16 kHz mono 16-bit WAV, max 2 s).

import type { BuiltinShutterSound } from '../protocol/types';

export const SOUND_SAMPLE_RATE = 16000;
export const MAX_SOUND_MS = 2000;

export type BuiltinSoundId = BuiltinShutterSound | 'startup' | 'ui' | 'save' | 'warning';

/** Master volume 0..10 → linear gain. 0 is a hard mute, like the device. */
export function volumeToGain(volume: number): number {
  const v = Math.max(0, Math.min(10, volume));
  return (v / 10) ** 2 * 0.8;
}

let ctx: AudioContext | null = null;

function audioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function tone(
  ac: AudioContext,
  dest: AudioNode,
  opts: { freq: number; type?: OscillatorType; at: number; durMs: number; gain?: number },
) {
  const osc = ac.createOscillator();
  osc.type = opts.type ?? 'sine';
  osc.frequency.value = opts.freq;
  const g = ac.createGain();
  const dur = opts.durMs / 1000;
  const peak = opts.gain ?? 0.5;
  g.gain.setValueAtTime(0, opts.at);
  g.gain.linearRampToValueAtTime(peak, opts.at + 0.004);
  g.gain.exponentialRampToValueAtTime(0.001, opts.at + dur);
  osc.connect(g);
  g.connect(dest);
  osc.start(opts.at);
  osc.stop(opts.at + dur + 0.02);
}

function noiseBurst(
  ac: AudioContext,
  dest: AudioNode,
  opts: { at: number; durMs: number; filterHz: number; q?: number; gain?: number },
) {
  const frames = Math.max(1, Math.round((opts.durMs / 1000) * ac.sampleRate));
  const buf = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.exp((-5 * i) / frames);
  }
  const src = ac.createBufferSource();
  src.buffer = buf;
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = opts.filterHz;
  filter.Q.value = opts.q ?? 0.9;
  const g = ac.createGain();
  g.gain.value = opts.gain ?? 0.7;
  src.connect(filter);
  filter.connect(g);
  g.connect(dest);
  src.start(opts.at);
}

/** Preview a firmware-builtin sound. 'silent' and volume 0 play nothing. */
export function playBuiltin(id: BuiltinSoundId, volume: number): void {
  const master = volumeToGain(volume);
  if (master <= 0 || id === 'silent') return;
  const ac = audioContext();
  const out = ac.createGain();
  out.gain.value = master;
  out.connect(ac.destination);
  const t = ac.currentTime + 0.02;

  switch (id) {
    case 'click':
      noiseBurst(ac, out, { at: t, durMs: 24, filterHz: 2600, gain: 0.9 });
      break;
    case 'cheap-digi':
      tone(ac, out, { freq: 1250, type: 'square', at: t, durMs: 34, gain: 0.28 });
      tone(ac, out, { freq: 830, type: 'square', at: t + 0.07, durMs: 55, gain: 0.28 });
      break;
    case 'tiny-beep':
      tone(ac, out, { freq: 2093, at: t, durMs: 70, gain: 0.4 });
      break;
    case 'mechanical':
      noiseBurst(ac, out, { at: t, durMs: 22, filterHz: 1800, gain: 0.8 });
      tone(ac, out, { freq: 140, at: t, durMs: 30, gain: 0.35 });
      noiseBurst(ac, out, { at: t + 0.09, durMs: 34, filterHz: 1200, q: 0.7, gain: 0.9 });
      break;
    case 'startup':
      tone(ac, out, { freq: 660, at: t, durMs: 90, gain: 0.35 });
      tone(ac, out, { freq: 880, at: t + 0.1, durMs: 130, gain: 0.35 });
      break;
    case 'ui':
      tone(ac, out, { freq: 1500, at: t, durMs: 16, gain: 0.25 });
      break;
    case 'save':
      tone(ac, out, { freq: 1047, at: t, durMs: 60, gain: 0.35 });
      tone(ac, out, { freq: 1319, at: t + 0.08, durMs: 90, gain: 0.35 });
      break;
    case 'warning':
      for (let i = 0; i < 3; i++) {
        tone(ac, out, { freq: 1000, type: 'square', at: t + i * 0.15, durMs: 80, gain: 0.3 });
      }
      break;
  }
}

/** Play an uploaded clip (WAV bytes as stored on the device). */
export async function playWav(bytes: Uint8Array, volume: number): Promise<void> {
  const master = volumeToGain(volume);
  if (master <= 0) return;
  const ac = audioContext();
  // decodeAudioData detaches its input — hand it a copy.
  const copy = new Uint8Array(bytes).buffer;
  const decoded = await ac.decodeAudioData(copy);
  const src = ac.createBufferSource();
  src.buffer = decoded;
  const g = ac.createGain();
  g.gain.value = master;
  src.connect(g);
  g.connect(ac.destination);
  src.start();
}

/** Encode mono float samples as a 16-bit PCM RIFF/WAVE file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataLen = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++) {
    const c = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, Math.round(c * 32767), true);
    o += 2;
  }
  return new Uint8Array(buf);
}

export interface PreparedSound {
  wav: Uint8Array;
  durationMs: number;
  /** Input ran past MAX_SOUND_MS and was cut. */
  trimmed: boolean;
}

/**
 * Convert a user audio file to the device format: decode (WAV/MP3/OGG —
 * whatever the browser can), downmix to mono, resample to 16 kHz, trim to
 * 2 s with a short fade so the cut doesn't click.
 */
export async function prepareSoundFile(file: File): Promise<PreparedSound> {
  const raw = await file.arrayBuffer();
  const ac = audioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ac.decodeAudioData(raw);
  } catch {
    throw new Error('Not a playable audio file. Use WAV, MP3 or OGG.');
  }
  const srcMs = (decoded.length / decoded.sampleRate) * 1000;
  const useMs = Math.min(srcMs, MAX_SOUND_MS);
  const frames = Math.max(1, Math.round((useMs / 1000) * SOUND_SAMPLE_RATE));
  const off = new OfflineAudioContext(1, frames, SOUND_SAMPLE_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  const samples = rendered.getChannelData(0);
  const trimmed = srcMs > MAX_SOUND_MS + 1;
  if (trimmed) {
    const fade = Math.min(samples.length, Math.round(SOUND_SAMPLE_RATE * 0.02));
    for (let i = 0; i < fade; i++) {
      samples[samples.length - 1 - i] *= i / fade;
    }
  }
  return { wav: encodeWav(samples, SOUND_SAMPLE_RATE), durationMs: Math.round(useMs), trimmed };
}

/** Stable device id for an uploaded file. Same name replaces the old clip. */
export function soundIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/\.[^.]*$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return `snd-${slug || 'sound'}`;
}

/** Display name from a file name: extension off, length capped. */
export function soundNameFromFile(fileName: string): string {
  return fileName.replace(/\.[^.]*$/, '').slice(0, 32) || 'sound';
}
