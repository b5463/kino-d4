#include "cam_sched.h"

#include <string.h>

static bool valid(int cam) { return cam >= 0 && cam < CAM_SCHED_CAMS; }

void cam_sched_init(cam_sched_t *s) {
  if (s == NULL) return;
  memset(s, 0, sizeof *s);
}

int cam_sched_probes_active(const cam_sched_t *s) {
  if (s == NULL) return 0;
  int n = 0;
  for (int i = 0; i < CAM_SCHED_CAMS; i++) {
    if (s->probe_active[i]) n++;
  }
  return n;
}

bool cam_sched_capture_admit(cam_sched_t *s) {
  if (s == NULL) return false;
  /* The one real BUSY: a capture (or a bench path) already owns the cameras.
   * Maintenance is not a capture and never reaches this branch. */
  if (s->capture_active) return false;
  s->capture_active = true;
  /* Admitted. A probe in flight finishes its one transaction; nothing new
   * begins. The capture waits for that boundary, and only that. */
  s->capture_pending = cam_sched_probes_active(s) > 0;
  if (s->capture_pending) s->capture_waits++;
  return true;
}

bool cam_sched_capture_ready(const cam_sched_t *s) {
  if (s == NULL) return false;
  return cam_sched_probes_active(s) == 0;
}

void cam_sched_capture_started(cam_sched_t *s) {
  if (s == NULL) return;
  s->capture_pending = false;
}

void cam_sched_capture_done(cam_sched_t *s) {
  if (s == NULL) return;
  s->capture_active = false;
  s->capture_pending = false;
}

bool cam_sched_probe_begin(cam_sched_t *s, int cam) {
  if (s == NULL || !valid(cam)) return false;
  /* Photography wins, and it wins from the moment it is admitted - a capture
   * still waiting for another channel's probe must not see a fresh probe
   * start on this one. One transaction per channel at a time, too. */
  if (s->capture_active || s->capture_pending || s->probe_active[cam]) {
    s->probes_deferred++;
    return false;
  }
  s->probe_active[cam] = true;
  s->probes_run++;
  return true;
}

bool cam_sched_probe_end(cam_sched_t *s, int cam) {
  if (s == NULL || !valid(cam)) return false;
  if (!s->probe_active[cam]) return false;
  s->probe_active[cam] = false;
  return s->capture_pending && cam_sched_probes_active(s) == 0;
}
