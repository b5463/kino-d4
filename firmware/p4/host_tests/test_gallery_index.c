/*
 * Host tests for firmware/p4/main/gallery_index.c - the gallery's persistent
 * order index, on the card and back again.
 *
 *   make -C firmware/p4/host_tests test-index      # no dependencies
 *
 * This file is on a removable card, so every byte of it is input someone can
 * edit in a PC, and every name that comes out of it is snprintf'd into a path
 * and opened. So the negative cases matter more than the positive one: a name
 * with a slash in it, a leading dot, a length that does not fit the gallery's
 * own table, a millisecond field that is not a number, a header from a version
 * this firmware does not know.
 *
 * The other half is detection. A capture written between the index being
 * loaded and the power going out leaves a file whose header count disagrees
 * with the lines in it, and the whole point of the count is that the disagree-
 * ment is what triggers a rebuild rather than a gallery in the wrong order.
 * Nothing on the device can catch that, because by definition it only happens
 * when the device stopped.
 */
#include <stdio.h>
#include <string.h>

#include "gallery_index.h"

static int checks = 0;
static int failures = 0;

#define CHECK(cond, ...)                          \
  do {                                            \
    checks++;                                     \
    if (!(cond)) {                                \
      failures++;                                 \
      printf("FAIL %s:%d: ", __FILE__, __LINE__); \
      printf(__VA_ARGS__);                        \
      printf("\n");                               \
    }                                             \
  } while (0)

/* The gallery's cap, mirrored here rather than included: gallery.c pulls in
 * FreeRTOS and the JPEG codec, and this suite must build with a plain
 * compiler. A disagreement shows up as a bounds test that stops proving
 * anything, which is why the number is named in both places. */
#define MAX_SCAN 240

/* ------------------------------------------------------------------ */
/* One line, both ways                                                 */
/* ------------------------------------------------------------------ */

static void test_line_round_trip(void) {
  char line[GIDX_LINE_MAX];
  const uint64_t when = 1772476800123ull; /* 13 digits, as a real capture is */
  const char *name = "07f5d03c-4a1b-4f2e-9c8d-1234567890ab";

  const size_t wrote = gidx_render_line(line, sizeof line, when, name);
  CHECK(wrote > 0, "render refused a good line");
  CHECK(line[wrote - 1] == '\n', "rendered line does not end in a newline");
  /* 13 + 1 + 36 + 1: the measured real-world line length the buffer bound in
   * gallery_index.h is calculated from. */
  CHECK(wrote == 51, "a real line measured %u bytes, expected 51", (unsigned)wrote);

  /* The parser is fed the line with the newline stripped, which is what
   * gidx_parse does for it. */
  line[wrote - 1] = '\0';
  gidx_entry_t e;
  memset(&e, 0, sizeof e);
  CHECK(gidx_parse_line(line, &e), "parse rejected its own output");
  CHECK(e.captured_at_ms == when, "timestamp came back %llu, expected %llu",
        (unsigned long long)e.captured_at_ms, (unsigned long long)when);
  CHECK(strcmp(e.name, name) == 0, "name came back \"%s\"", e.name);
}

static void reject_line(const char *what, const char *line) {
  gidx_entry_t e;
  memset(&e, 0, sizeof e);
  CHECK(!gidx_parse_line(line, &e), "%s: accepted \"%s\"", what, line);
}

static void test_line_rejects(void) {
  reject_line("empty", "");
  reject_line("no timestamp", "abc def");
  reject_line("no name", "1772476800123 ");
  reject_line("no separator", "1772476800123");
  reject_line("two spaces", "1772476800123  name");
  reject_line("a space inside the name", "1772476800123 na me");
  reject_line("a leading dot", "1772476800123 .hidden");
  reject_line("the dot entry", "1772476800123 .");
  /* The one that matters: this name would have been opened as a path. */
  reject_line("a path escape", "1772476800123 ../../KINO/CONFIG.JSON");
  reject_line("a slash", "1772476800123 a/b");
  reject_line("a backslash", "1772476800123 a\\b");
  reject_line("a negative timestamp", "-1 name");
  reject_line("a hex timestamp", "0x10 name");
  reject_line("a timestamp longer than a uint64", "99999999999999999999 name");

  /* Exactly the length gallery.c's s_names[40] holds, and one over it. A name
   * that does not fit there cannot be shown, so it must not be stored. */
  char at_limit[GIDX_NAME_MAX + 16];
  char over[GIDX_NAME_MAX + 16];
  int n = snprintf(at_limit, sizeof at_limit, "1 ");
  memset(at_limit + n, 'a', GIDX_NAME_MAX - 1);
  at_limit[n + GIDX_NAME_MAX - 1] = '\0';
  gidx_entry_t e;
  CHECK(gidx_parse_line(at_limit, &e), "a 39-character name was rejected");

  n = snprintf(over, sizeof over, "1 ");
  memset(over + n, 'a', GIDX_NAME_MAX);
  over[n + GIDX_NAME_MAX] = '\0';
  reject_line("a 40-character name", over);
}

/* ------------------------------------------------------------------ */
/* The header                                                          */
/* ------------------------------------------------------------------ */

static void test_header(void) {
  char line[GIDX_LINE_MAX];
  CHECK(gidx_render_header(line, sizeof line, 240, 517) > 0, "render refused a good header");

  gidx_header_t h;
  memset(&h, 0, sizeof h);
  /* strip the newline the way gidx_parse does */
  line[strlen(line) - 1] = '\0';
  CHECK(gidx_parse_header(line, &h), "parse rejected its own header (\"%s\")", line);
  CHECK(h.version == GIDX_VERSION, "version came back %u", h.version);
  CHECK(h.entries == 240, "entries came back %d", h.entries);
  CHECK(h.total_seen == 517, "total_seen came back %d", h.total_seen);

  /* total_seen below entries describes nothing that can exist, and it is the
   * field the verify pass compares against - so it is refused at both ends. */
  CHECK(gidx_render_header(line, sizeof line, 10, 4) == 0,
        "render wrote a header claiming 10 of 4");
  CHECK(!gidx_parse_header("KINOIDX 1 10 4", &h), "parse accepted 10 entries out of 4 seen");

  CHECK(!gidx_parse_header("KINOIDX 2 1 1", &h), "parse accepted a version-2 index");
  CHECK(!gidx_parse_header("KINOIDX 1 1", &h), "parse accepted a header missing total_seen");
  CHECK(!gidx_parse_header("KINOIDX 1 1 1 1", &h), "parse accepted a fourth column");
  CHECK(!gidx_parse_header("KINOIDX", &h), "parse accepted the magic alone");
  CHECK(!gidx_parse_header("KINOID 1 1 1", &h), "parse accepted the wrong magic");
  CHECK(!gidx_parse_header("", &h), "parse accepted an empty header");
  CHECK(gidx_parse_header("KINOIDX 1 0 0", &h), "parse rejected an empty but valid index");
  CHECK(h.entries == 0 && h.total_seen == 0, "an empty index parsed as %d/%d", h.entries,
        h.total_seen);
}

/* ------------------------------------------------------------------ */
/* A whole file                                                        */
/* ------------------------------------------------------------------ */

#define THREE_LINES                    \
  "300 ccccccc\n"                      \
  "200 bbbbbbb\n"                      \
  "100 aaaaaaa\n"

static void test_file_round_trip(void) {
  gidx_entry_t out[MAX_SCAN];
  gidx_header_t h;
  int skipped = -1;

  const int n = gidx_parse("KINOIDX 1 3 3\n" THREE_LINES, out, MAX_SCAN, &h, &skipped);
  CHECK(n == 3, "parsed %d entries, expected 3", n);
  CHECK(skipped == 0, "skipped %d lines of a clean file", skipped);
  CHECK(n == h.entries, "count %d disagrees with the header's %d", n, h.entries);
  CHECK(out[0].captured_at_ms == 300 && strcmp(out[0].name, "ccccccc") == 0,
        "first entry is %llu %s", (unsigned long long)out[0].captured_at_ms, out[0].name);
  CHECK(out[2].captured_at_ms == 100 && strcmp(out[2].name, "aaaaaaa") == 0,
        "last entry is %llu %s", (unsigned long long)out[2].captured_at_ms, out[2].name);
}

static void test_no_header(void) {
  gidx_entry_t out[MAX_SCAN];
  gidx_header_t h;
  /* No header at all is the only unrecoverable case: there is nothing to
   * check the entries against, so the caller has to rebuild. */
  CHECK(gidx_parse(THREE_LINES, out, MAX_SCAN, &h, NULL) == -1, "parsed a headerless file");
  CHECK(gidx_parse("", out, MAX_SCAN, &h, NULL) == -1, "parsed an empty file");
  CHECK(gidx_parse("KINOIDX 1 0 0", out, MAX_SCAN, &h, NULL) == -1,
        "parsed a header with no newline after it");
}

static void test_truncated(void) {
  gidx_entry_t out[MAX_SCAN];
  gidx_header_t h;
  int skipped = -1;

  /* The power-cut case: the header says three, the third line never reached
   * the card. The last line has no newline, so it is not counted at all - and
   * the count disagreeing with the header is what makes the caller rebuild. */
  const int n = gidx_parse("KINOIDX 1 3 3\n300 ccccccc\n200 bbbbbbb\n100 aaa", out, MAX_SCAN, &h,
                           &skipped);
  CHECK(n == 2, "a truncated file parsed %d entries, expected 2", n);
  CHECK(n != h.entries, "the truncation was not detectable from the count");
  CHECK(skipped == 0, "an unterminated tail was counted as a skipped line");
}

static void test_corrupt_line_skipped(void) {
  gidx_entry_t out[MAX_SCAN];
  gidx_header_t h;
  int skipped = -1;

  /* One bad line in the middle must cost one capture, not the file. This is
   * the difference between a gallery missing a photograph and a gallery that
   * re-reads 500 META.JSONs. */
  const int n = gidx_parse("KINOIDX 1 4 4\n"
                           "400 dddddddd\n"
                           "not a line at all\n"
                           "200 bbbbbbb\n"
                           "100 aaaaaaa\n",
                           out, MAX_SCAN, &h, &skipped);
  CHECK(n == 3, "parsed %d entries either side of a corrupt line, expected 3", n);
  CHECK(skipped == 1, "skipped %d lines, expected 1", skipped);
  CHECK(strcmp(out[0].name, "dddddddd") == 0, "the line before the corruption was lost");
  CHECK(strcmp(out[1].name, "bbbbbbb") == 0, "the line after the corruption was lost");
  CHECK(strcmp(out[2].name, "aaaaaaa") == 0, "the rest of the file was lost");
  CHECK(n != h.entries, "a skipped line did not show up as a count mismatch");

  /* A line longer than the working buffer is skipped, not truncated: a
   * truncated name maps to a directory that does not exist. */
  char long_line[GIDX_LINE_MAX + 64];
  int at = snprintf(long_line, sizeof long_line, "KINOIDX 1 1 1\n1 ");
  memset(long_line + at, 'a', GIDX_LINE_MAX + 8);
  at += GIDX_LINE_MAX + 8;
  long_line[at++] = '\n';
  long_line[at] = '\0';
  skipped = -1;
  CHECK(gidx_parse(long_line, out, MAX_SCAN, &h, &skipped) == 0, "an overlong line was accepted");
  CHECK(skipped == 1, "an overlong line was not counted as skipped");
}

static void test_over_the_cap(void) {
  /* A file holding more lines than the caller has room for. The extra lines
   * are counted as skipped and the count therefore disagrees with the header,
   * which is the honest answer: this index does not fit this firmware. */
  char big[64 + 8 * 40];
  int at = snprintf(big, sizeof big, "KINOIDX 1 8 8\n");
  for (int i = 8; i > 0; i--) {
    at += snprintf(big + at, sizeof big - (size_t)at, "%d name%d\n", i * 100, i);
  }
  gidx_entry_t out[4];
  gidx_header_t h;
  int skipped = -1;
  const int n = gidx_parse(big, out, 4, &h, &skipped);
  CHECK(n == 4, "parsed %d entries into room for 4", n);
  CHECK(skipped == 4, "%d lines past the cap were counted, expected 4", skipped);
  CHECK(n != h.entries, "an index too big for this firmware looked consistent");
  /* Newest first, so the four that fit are the four that matter. */
  CHECK(strcmp(out[0].name, "name8") == 0, "the newest entry was not kept, got %s", out[0].name);
}

/* ------------------------------------------------------------------ */
/* The bits gallery.c leans on                                         */
/* ------------------------------------------------------------------ */

static void test_oldest(void) {
  /* The eviction rule past MAX_SCAN: replace the oldest held entry, never the
   * first one seen. A card holding 500 captures would otherwise show only
   * history. */
  const uint64_t ms[5] = {500, 100, 900, 100, 300};
  CHECK(gidx_oldest(ms, 5) == 1, "oldest of five was %d, expected the first 100 at 1",
        gidx_oldest(ms, 5));
  const uint64_t one[1] = {7};
  CHECK(gidx_oldest(one, 1) == 0, "oldest of one was not 0");
  CHECK(gidx_oldest(ms, 0) == -1, "oldest of none was not -1");
  CHECK(gidx_oldest(NULL, 4) == -1, "oldest of NULL was not -1");

  /* All equal: any answer is correct, but it must be in range - this feeds a
   * memcpy into s_names. */
  const uint64_t flat[3] = {4, 4, 4};
  const int f = gidx_oldest(flat, 3);
  CHECK(f >= 0 && f < 3, "oldest of three equal times was %d", f);
}

static void test_index_file_names(void) {
  /* Every walk that counts capture folders sees these, because they live in
   * the captures directory. One missed skip makes the card look like it holds
   * one more capture than it does, which the verify pass then reports as a
   * mismatch on every single gallery open. */
  CHECK(gidx_is_index_file("INDEX.TXT"), "INDEX.TXT was not recognised");
  CHECK(gidx_is_index_file("INDEX.TMP"), "INDEX.TMP was not recognised");
  CHECK(gidx_is_index_file("index.txt"), "a lower-case name was not recognised - FAT is not");
  CHECK(!gidx_is_index_file("INDEX.TXT2"), "a longer name matched");
  CHECK(!gidx_is_index_file("INDEX"), "a shorter name matched");
  CHECK(!gidx_is_index_file(""), "an empty name matched");
  CHECK(!gidx_is_index_file(NULL), "NULL matched");
  CHECK(!gidx_is_index_file("07f5d03c-4a1b-4f2e-9c8d-1234567890ab"), "a capture UUID matched");
}

static void test_max_bytes(void) {
  /* The reader sizes one buffer from this and rejects a bigger file outright.
   * It has to be an upper bound on what the writer can produce, or a full
   * index would be rejected as corrupt for ever. */
  const size_t bound = gidx_max_bytes(MAX_SCAN);
  char line[GIDX_LINE_MAX];
  size_t worst = gidx_render_header(line, sizeof line, MAX_SCAN, MAX_SCAN);
  CHECK(worst > 0, "the widest header did not render");

  char name[GIDX_NAME_MAX];
  memset(name, 'a', GIDX_NAME_MAX - 1);
  name[GIDX_NAME_MAX - 1] = '\0';
  const size_t widest = gidx_render_line(line, sizeof line, 9999999999999999999ull, name);
  CHECK(widest > 0, "the widest line did not render");
  worst += widest * MAX_SCAN;
  CHECK(worst <= bound, "the widest possible file is %u bytes against a bound of %u",
        (unsigned)worst, (unsigned)bound);
  CHECK(gidx_max_bytes(0) > 0, "an empty index has no room for its header");
  CHECK(gidx_max_bytes(-1) > 0, "a negative cap produced no bound");
}

int main(void) {
  test_line_round_trip();
  test_line_rejects();
  test_header();
  test_file_round_trip();
  test_no_header();
  test_truncated();
  test_corrupt_line_skipped();
  test_over_the_cap();
  test_oldest();
  test_index_file_names();
  test_max_bytes();

  printf("%s: %d checks, %d failures\n", failures ? "FAILED" : "ok", checks, failures);
  return failures ? 1 : 0;
}
