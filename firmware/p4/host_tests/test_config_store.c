/*
 * Host tests for config_store.c - two writers, one reader, one NVS.
 *
 *   make -C firmware/p4/host_tests test-config
 *
 * The KDP task (SET_CONFIG + SAVE_CONFIG) and the UI task (a settings tap)
 * both merge and save. config_save() prints under the document lock and
 * commits outside it, so two savers could commit in the other order and leave
 * an older revision in NVS than the one the camera runs on. GET_CONFIG walked
 * the live document without the lock while a merge relinked it (#242).
 *
 * The in-memory NVS below sleeps inside nvs_set_str to widen exactly the
 * window the save lock closes, and records every commit. The checks: commits
 * land in revision order, the last commit is the live revision, a snapshot is
 * always a whole document, and config_flush() writes nothing while saves are
 * immediate. Needs cJSON (the container's), like test-meta.
 */
#include "config_store.h"

#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "klog.h"
#include "nvs.h"

static int fails = 0;
static int checks = 0;

#define CHECK(cond, ...)                          \
  do {                                            \
    checks++;                                     \
    if (!(cond)) {                                \
      fails++;                                    \
      printf("FAIL %s:%d: ", __FILE__, __LINE__); \
      printf(__VA_ARGS__);                        \
      printf("\n");                               \
    }                                             \
  } while (0)

/* ---- stubs ---------------------------------------------------------- */

void klog(const char *src, const char *fmt, ...) {
  (void)src;
  (void)fmt;
}

const char *esp_err_to_name(esp_err_t err) {
  (void)err;
  return "ERR";
}

/* ---- in-memory NVS -------------------------------------------------- */

#define MAX_COMMITS 4096
#define NVS_CAP 4096

static pthread_mutex_t s_nvs = PTHREAD_MUTEX_INITIALIZER;
static char s_stored[NVS_CAP];
static bool s_has_stored;
static long s_commit_rev[MAX_COMMITS];
static int s_commits;
/* One staged value per handle; config_store.c opens a fresh handle per save. */
static char s_staged[64][NVS_CAP];
static uint32_t s_next_handle;

static void short_sleep(unsigned seed) {
  struct timespec ts = {0, (long)(seed % 300u) * 1000L};
  nanosleep(&ts, NULL);
}

static long revision_of(const char *text) {
  const char *p = strstr(text, "\"configRevision\":");
  return p ? strtol(p + strlen("\"configRevision\":"), NULL, 10) : -1;
}

esp_err_t nvs_open(const char *ns, nvs_open_mode_t mode, nvs_handle_t *out) {
  (void)ns;
  (void)mode;
  pthread_mutex_lock(&s_nvs);
  *out = s_next_handle++ % 64u;
  pthread_mutex_unlock(&s_nvs);
  return ESP_OK;
}

esp_err_t nvs_get_str(nvs_handle_t h, const char *key, char *out, size_t *len) {
  (void)h;
  (void)key;
  pthread_mutex_lock(&s_nvs);
  esp_err_t err = ESP_ERR_NOT_FOUND;
  if (s_has_stored) {
    const size_t need = strlen(s_stored) + 1;
    if (out != NULL && *len >= need) memcpy(out, s_stored, need);
    *len = need;
    err = ESP_OK;
  }
  pthread_mutex_unlock(&s_nvs);
  return err;
}

esp_err_t nvs_set_str(nvs_handle_t h, const char *key, const char *value) {
  (void)key;
  /* A flash write takes time; this is the window two savers race in. */
  short_sleep((unsigned)rand());
  snprintf(s_staged[h], sizeof s_staged[h], "%s", value);
  return ESP_OK;
}

esp_err_t nvs_commit(nvs_handle_t h) {
  short_sleep((unsigned)rand());
  pthread_mutex_lock(&s_nvs);
  snprintf(s_stored, sizeof s_stored, "%s", s_staged[h]);
  s_has_stored = true;
  if (s_commits < MAX_COMMITS) s_commit_rev[s_commits] = revision_of(s_stored);
  s_commits++;
  pthread_mutex_unlock(&s_nvs);
  return ESP_OK;
}

void nvs_close(nvs_handle_t h) { (void)h; }

static int commits(void) {
  pthread_mutex_lock(&s_nvs);
  const int n = s_commits;
  pthread_mutex_unlock(&s_nvs);
  return n;
}

/* ---- the race ------------------------------------------------------- */

#define ROUNDS 150

static void *writer(void *arg) {
  const int who = (int)(long)arg;
  for (int i = 0; i < ROUNDS; i++) {
    char text[96];
    snprintf(text, sizeof text, "{\"body\":{\"brightness\":%d,\"autoDimS\":%d}}", i % 11,
             who * 1000 + i);
    cJSON *patch = cJSON_Parse(text);
    if (config_merge(patch) != ESP_OK) CHECK(false, "merge refused");
    cJSON_Delete(patch);
    if (config_save() != ESP_OK) CHECK(false, "save refused");
  }
  return NULL;
}

static volatile int s_writers_done;
static int s_snapshots;
static int s_bad_snapshots;
static int s_backward_revisions;

static void *reader(void *arg) {
  (void)arg;
  uint32_t last = 0;
  while (!s_writers_done) {
    uint32_t rev = 0;
    cJSON *copy = config_snapshot(&rev);
    const cJSON *body = copy ? cJSON_GetObjectItem(copy, "body") : NULL;
    const cJSON *mode = copy ? cJSON_GetObjectItem(copy, "mode") : NULL;
    if (!cJSON_IsObject(body) || !cJSON_IsString(mode) ||
        !cJSON_IsNumber(cJSON_GetObjectItem(body, "autoDimS"))) {
      s_bad_snapshots++;
    }
    if (rev < last) s_backward_revisions++;
    last = rev;
    cJSON_Delete(copy);
    s_snapshots++;
  }
  return NULL;
}

static void test_two_writers(void) {
  pthread_t a, b, r;
  s_writers_done = 0;
  const int before = commits();
  pthread_create(&r, NULL, reader, NULL);
  pthread_create(&a, NULL, writer, (void *)1L);
  pthread_create(&b, NULL, writer, (void *)2L);
  pthread_join(a, NULL);
  pthread_join(b, NULL);
  s_writers_done = 1;
  pthread_join(r, NULL);

  const int n = commits() - before;
  CHECK(n == 2 * ROUNDS, "every save commits once: %d of %d", n, 2 * ROUNDS);

  int out_of_order = 0;
  for (int i = before + 1; i < s_commits && i < MAX_COMMITS; i++) {
    if (s_commit_rev[i] < s_commit_rev[i - 1]) out_of_order++;
  }
  CHECK(out_of_order == 0, "commits land in revision order: %d went backwards", out_of_order);

  const long last = s_commit_rev[(s_commits < MAX_COMMITS ? s_commits : MAX_COMMITS) - 1];
  CHECK(last == (long)config_revision(), "NVS holds the live revision: stored %ld, live %lu",
        last, (unsigned long)config_revision());

  CHECK(s_snapshots > 0, "the reader ran");
  CHECK(s_bad_snapshots == 0, "every snapshot is a whole document: %d were not", s_bad_snapshots);
  CHECK(s_backward_revisions == 0, "snapshot revisions never go backwards: %d did",
        s_backward_revisions);
}

static void test_snapshot_is_a_copy(void) {
  uint32_t rev = 0;
  cJSON *copy = config_snapshot(&rev);
  CHECK(copy != NULL, "a snapshot exists");
  CHECK(rev == config_revision(), "snapshot revision is the live one");
  cJSON *body = cJSON_GetObjectItem(copy, "body");
  cJSON_ReplaceItemInObject(body, "brightness", cJSON_CreateNumber(99));
  CHECK(config_int("body.brightness", -1) != 99, "editing the copy leaves the store alone");
  cJSON_Delete(copy);
}

static void test_flush(void) {
  const int before = commits();
  CHECK(config_flush(false) == ESP_OK, "flush with nothing pending is ok");
  CHECK(config_flush(true) == ESP_OK, "forced flush with nothing pending is ok");
  CHECK(commits() == before, "flush writes nothing while saves are immediate: %d writes",
        commits() - before);

  /* A merge nobody saved stays out of NVS, forced flush or not. */
  cJSON *patch = cJSON_Parse("{\"body\":{\"brightness\":3}}");
  CHECK(config_merge(patch) == ESP_OK, "merge");
  cJSON_Delete(patch);
  CHECK(config_flush(true) == ESP_OK, "forced flush");
  CHECK(commits() == before, "an unsaved merge is not flushed");
}

int main(void) {
  srand(242);
  CHECK(config_init() == ESP_OK, "init on an empty NVS builds the defaults");
  CHECK(config_int("body.autoDimS", -1) == 30, "defaults are in place");

  test_snapshot_is_a_copy();
  test_two_writers();
  test_flush();

  printf("%d checks, %d failed\n", checks, fails);
  return fails == 0 ? 0 : 1;
}
