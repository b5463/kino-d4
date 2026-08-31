/**
 * The gallery's persistent order index: one text file, parsed and rendered
 * here so both halves can be tested without a card.
 *
 * ## Why the file exists at all
 *
 * The gallery shows captures newest first, and a capture folder is named by
 * UUID, so readdir order says nothing about time. The only trustworthy
 * timestamp is `capturedAtMs` inside each capture's META.JSON (stat() on the
 * folder and on the file both came back sorting every capture equal through
 * esp_vfs_fat — see gallery.c). Reading it costs 5-15 ms per capture, so a
 * card with ~500 captures spent 2.5-7.5 s of card time on every single gallery
 * open, holding STORAGE_USER_UI for all of it, and started again from zero
 * whenever a shutter press asked for the card back.
 *
 * The order only changes when a capture is written or deleted, or when someone
 * edits the card in a PC. So it is written down once and read back in one
 * fread.
 *
 * ## The format
 *
 *   KINOIDX 1 <entries> <total_seen>\n
 *   <capturedAtMs> <dirname>\n
 *   ... one line per capture, newest first
 *
 * Text, not a struct: it is written and read by one program on one
 * architecture, so a binary record would buy nothing, and a text file can be
 * read by eye off a card that is misbehaving. Decimal milliseconds and a
 * single space, because that is the cheapest thing to parse that a person can
 * still check.
 *
 * `entries` is how many capture lines follow — a count that disagrees with the
 * lines present means a truncated or half-written file, which is the whole
 * detection mechanism for a power cut mid-write.
 *
 * `total_seen` is how many capture folders the walk that produced the file
 * counted, which is NOT `entries` on a card holding more than the gallery's
 * cap. That distinction is the reason the field exists: the cheap
 * verify-the-index pass counts folders with readdir and compares against
 * `total_seen`. Comparing against `entries` on a 500-capture card would
 * disagree for ever and rebuild the index on every gallery open — the exact
 * cost the file was added to remove.
 *
 * Rules for this file: C99, no ESP-IDF headers, no allocation, no I/O, no
 * globals — the same rules as pure.h, for the same reason.
 */
#ifndef P4_GALLERY_INDEX_H
#define P4_GALLERY_INDEX_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** Bumped when the line shape changes. An index with any other version is
 * discarded and rebuilt rather than guessed at. */
#define GIDX_VERSION 1u

#define GIDX_MAGIC "KINOIDX"

/** Matches `s_names[40]` in gallery.c, which matches the length gallery's
 * scan() accepts from readdir. A name that does not fit there cannot be shown,
 * so it must not be storable here either. */
#define GIDX_NAME_MAX 40

/**
 * Working buffer one line needs, including the NUL.
 *
 * The longest line this writer can produce is 19 digits of milliseconds, a
 * space, 39 characters of name and a newline: 60 bytes. 72 leaves room for a
 * CR from a card that has been through a PC editor and for the NUL, and a
 * longer line than that is rejected rather than truncated — a truncated name
 * maps to a directory that does not exist.
 */
#define GIDX_LINE_MAX 72

/** The two names this index occupies inside the captures directory. Both are
 * 8.3, because the card is FAT and a long-name entry costs directory slots for
 * nothing. */
#define GIDX_FILE "INDEX.TXT"
#define GIDX_TMP_FILE "INDEX.TMP"

typedef struct {
  uint64_t captured_at_ms;
  char name[GIDX_NAME_MAX];
} gidx_entry_t;

typedef struct {
  unsigned version;
  int entries;    /* capture lines the header claims follow */
  int total_seen; /* capture folders the walk counted; >= entries */
} gidx_header_t;

/**
 * Upper bound on the file for `max_entries`, so a reader can size one buffer
 * and reject anything larger without a second pass.
 *
 * 61 bytes per line is the worst case (see GIDX_LINE_MAX) plus the header. In
 * practice a capture's timestamp is 13 digits and its name a 36-character
 * UUID, so a real line is 51 bytes and a 240-entry file measures about
 * 12.3 KB against the 14.7 KB this returns.
 */
size_t gidx_max_bytes(int max_entries);

/**
 * True when `name` can be stored in this index and handed back safely.
 *
 * 1..GIDX_NAME_MAX-1 characters of alphanumerics, '-', '_' or '.', and never a
 * leading '.'. Not cosmetic: every name that comes out of this index is
 * snprintf'd into a path under the captures directory and then opened, and the
 * file it came from lives on a card anyone can edit in a PC. A name holding a
 * slash or starting with ".." would point the gallery outside its own
 * directory.
 *
 * Exported because the gallery's readdir walk has to apply the same test at
 * collection time: a folder it would show but could not store is a folder the
 * index and the count pass permanently disagree about.
 */
bool gidx_name_ok(const char *name);

/** True for the index's own files, which live in the captures directory and
 * are therefore handed back by every readdir over it. Every walk that counts
 * captures has to skip them, or the index makes the card look like it holds
 * one more capture than it does. Case-insensitive: FAT is. */
bool gidx_is_index_file(const char *name);

/** Bytes written, excluding the NUL; 0 when the arguments are refused or the
 * buffer is too small. The trailing newline is included. */
size_t gidx_render_header(char *out, size_t cap, int entries, int total_seen);
size_t gidx_render_line(char *out, size_t cap, uint64_t captured_at_ms, const char *name);

/** Parse one line, newline already stripped. False for anything that is not
 * exactly what the renderer above produces. */
bool gidx_parse_header(const char *line, gidx_header_t *out);
bool gidx_parse_line(const char *line, gidx_entry_t *out);

/**
 * Parse a whole index out of one NUL-terminated buffer.
 *
 * Returns the number of entries accepted into `out`, or -1 when there is no
 * usable header — the only unrecoverable case, because without the header
 * there is nothing to check the entries against.
 *
 * A malformed capture line is skipped and counted in `*skipped` rather than
 * ending the parse: one corrupt line must not cost the other 239 captures
 * their order. Only lines terminated by a newline are considered, so a file
 * cut short by a power failure loses its last line and the caller sees the
 * count disagree with the header.
 *
 * The caller decides what to do about `n != hdr->entries`. It is not an error
 * here because this function does not know whether a rebuild is cheap.
 */
int gidx_parse(const char *text, gidx_entry_t *out, int max, gidx_header_t *hdr, int *skipped);

/**
 * Index of the oldest of `n` timestamps, or -1 when there are none.
 *
 * The eviction rule for a card holding more captures than the gallery's cap:
 * past the cap the OLDEST held entry is replaced, never the first one seen, or
 * a full card would show only history. Factored out of gallery.c's scan so the
 * rule is testable and so the scan, the incremental add and the index load
 * cannot each grow their own version of it.
 */
int gidx_oldest(const uint64_t *ms, int n);

#endif
