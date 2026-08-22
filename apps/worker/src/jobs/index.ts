import type { JobName, JobHandler } from './types';
import { generateThumbnail } from './thumbnail';
import { generateGalleryStill } from './galleryStill';
import { renderContactSheet } from './contactSheet';
import { extractMetadata } from './metadata';
import { renderWiggleWebp } from './wiggleWebp';
import { renderWiggleMp4 } from './wiggleMp4';
import { renderSocialFormats } from './socialFormats';
import { generateRecap } from './recap';
import { aiEnhanceHandler } from './aiEnhance';
import { exportRoll } from './exportRoll';

/**
 * The image handlers, and the one place that binds a job name to a function.
 *
 * A single registration point rather than four calls in `main.ts` for two
 * reasons. A test needs the same set on its own queue, and a handler that was
 * implemented but never registered would not fail anything — the queue fails
 * unhandled jobs loudly (Task 22), but only once one is actually enqueued in
 * production. Here, a name added to `IMAGE_HANDLERS` without a function does not
 * type.
 *
 * Roll-scoped Task 25 work is kept in `ROLL_HANDLERS`; `purge-trash` is bound in
 * `main.ts` because it additionally receives the narrowly scoped eraser.
 *
 * The two wiggle renders are not queued alike. `plannedJobs` in the API
 * (`apps/api/src/uploads/uploads.ts`) already pushes `render-wiggle-webp` for
 * every `wiggle` capture at capture-complete, so registering it here is the half
 * that was missing: from this commit on, every wiggle capture gets an animated
 * WebP. `render-wiggle-mp4` is absent from that list and stays lazy — nothing
 * enqueues it yet, and it is produced on first request (see `wiggleMp4.ts`).
 */
export const IMAGE_HANDLERS: Readonly<Partial<Record<JobName, JobHandler>>> = {
  'generate-thumbnail': generateThumbnail,
  'generate-gallery-still': generateGalleryStill,
  'render-contact-sheet': renderContactSheet,
  'extract-metadata': extractMetadata,
  'render-wiggle-webp': renderWiggleWebp,
  'render-wiggle-mp4': renderWiggleMp4,
  'render-social-formats': renderSocialFormats,
};

/** Roll-scoped and optional handlers delivered by Task 25. */
export const ROLL_HANDLERS: Readonly<Partial<Record<JobName, JobHandler>>> = {
  'generate-recap': generateRecap,
  'ai-enhance': aiEnhanceHandler,
  'export-roll': exportRoll,
};

/** Just enough of a queue to register on, so this does not depend on the whole one. */
export interface HandlerRegistry {
  registerHandler(name: JobName, fn: JobHandler): void;
}

export function registerImageHandlers(registry: HandlerRegistry): void {
  for (const [name, handler] of Object.entries(IMAGE_HANDLERS)) {
    if (handler === undefined) continue;
    registry.registerHandler(name as JobName, handler);
  }
}

export function registerRollHandlers(registry: HandlerRegistry): void {
  for (const [name, handler] of Object.entries(ROLL_HANDLERS)) {
    if (handler === undefined) continue;
    registry.registerHandler(name as JobName, handler);
  }
}

export { generateThumbnail } from './thumbnail';
export { generateGalleryStill } from './galleryStill';
export { renderContactSheet } from './contactSheet';
export { extractMetadata } from './metadata';
export { renderWiggleWebp } from './wiggleWebp';
export { renderWiggleMp4 } from './wiggleMp4';
export { renderSocialFormats } from './socialFormats';
export { generateRecap } from './recap';
export { aiEnhance, aiEnhanceHandler } from './aiEnhance';
export { exportRoll } from './exportRoll';
