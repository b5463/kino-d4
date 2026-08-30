#pragma once
/*
 * Who may talk to the camera nodes right now: the shutter, or maintenance.
 *
 * The node UARTs already have the exclusion they need - cam_link.c holds one
 * mutex per channel for exactly one request/response transaction, so two
 * commands can never overlap on a wire. What that mutex cannot express is
 * priority: which of two tasks that both want a channel should get to START.
 *
 * Until 0.4.6 the background node sweep (cam_probe_task, main.c) answered that
 * by taking the shutter's own capture_lock() for its whole HELLO round, so a
 * CAMERA_CAPTURE arriving mid-sweep was refused BUSY "A capture is already
 * running" with no capture running - 14 of 20 idle requests before the 300 ms
 * absent-channel probe, 5 of 41 under Gate F load after it (bench 2026-08-30).
 * Maintenance was wearing the shutter's badge.
 *
 * This file is the policy, free of ESP-IDF so it is host-tested:
 *
 *   REAL CAPTURE  >  BACKGROUND NODE PROBE
 *
 *   - A probe may begin only when no capture is admitted (active or pending)
 *     and that channel has no probe in flight. Otherwise it is deferred, not
 *     queued: the sweep comes back later, there is nothing to remember.
 *   - A capture is admitted whenever no capture is active. Maintenance never
 *     makes it BUSY. If a probe transaction is in flight when the capture is
 *     admitted, the capture is PENDING until that transaction reaches its
 *     boundary (the probe's own bounded timeout: 300 ms on an absent channel,
 *     the node's reply time on a present one) and then starts. No probe can
 *     begin in between, so the wait is one transaction, never a sweep.
 *   - Channels are independent objects (CAM1-CAM4). Probes on different
 *     channels are allowed to be in flight at once by this policy; the sweep
 *     chooses to run them one at a time so four empty sockets do not time out
 *     together. A capture defers maintenance on every channel, because a
 *     capture fires every camera.
 *
 * The caller owns the real primitives: capture.c binds `capture_active` to
 * capture_lock(), the wait to a semaphore the probe's end signals, and the
 * channel work to cam_link.c. This struct is touched under one short lock.
 */

#include <stdbool.h>
#include <stdint.h>

#define CAM_SCHED_CAMS 4

typedef struct {
  /** A capture (or a bench path holding capture_lock) owns the cameras. */
  bool capture_active;
  /** A capture is admitted and waiting for an in-flight probe to end. */
  bool capture_pending;
  /** One bounded probe transaction is on this channel's wire. */
  bool probe_active[CAM_SCHED_CAMS];
  /* Counters for the bench: how often maintenance ran, stood aside, and how
   * often a shutter had to wait for a probe boundary. */
  uint32_t probes_run;
  uint32_t probes_deferred;
  uint32_t capture_waits;
} cam_sched_t;

void cam_sched_init(cam_sched_t *s);

/**
 * The shutter asks. False when a capture is already active - the one real
 * BUSY, unchanged. True admits the capture: from this instant no probe can
 * begin. If a probe is in flight the capture is marked pending and the caller
 * waits for cam_sched_capture_ready() (signalled by cam_sched_probe_end()).
 */
bool cam_sched_capture_admit(cam_sched_t *s);

/** True when no probe transaction is in flight - the admitted capture may
 * start talking to the nodes. */
bool cam_sched_capture_ready(const cam_sched_t *s);

/** The admitted capture has started; clears pending. */
void cam_sched_capture_started(cam_sched_t *s);

/** The capture (or bench path) has released the cameras. */
void cam_sched_capture_done(cam_sched_t *s);

/**
 * Maintenance asks to run one bounded transaction on `cam`. False means
 * deferred: a capture is active or pending, that channel is already being
 * probed, or `cam` is out of range. Nothing is queued; ask again later.
 */
bool cam_sched_probe_begin(cam_sched_t *s, int cam);

/**
 * The probe transaction on `cam` has reached its boundary. Returns true when
 * a pending capture is now ready - the caller signals whatever the capture
 * is waiting on. Ending a probe that was never begun changes nothing.
 */
bool cam_sched_probe_end(cam_sched_t *s, int cam);

/** Probe transactions in flight, all channels. */
int cam_sched_probes_active(const cam_sched_t *s);
