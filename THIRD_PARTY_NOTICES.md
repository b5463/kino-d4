# Third-party notices

Notices for third-party components that KINO artifacts distribute or invoke,
beyond the npm dependency graph recorded in `package-lock.json`. Repository
source licensing is in `LICENSE` and `REUSE.toml`.

## ffmpeg (GPL-2.0-or-later, with libx264)

The Roll worker's MP4 render (`apps/worker`) shells out to an ffmpeg built
with `--enable-gpl --enable-libx264`; x264 is GPL-2.0-or-later, which makes
that ffmpeg binary GPL. The worker invokes it as a separate process over a
command line (aggregation, not linking), so `apps/worker` itself remains MIT
— the obligation attaches to whoever distributes the ffmpeg binary.

- **Published worker image** (`infra/Dockerfile`, target `worker`): uses
  Debian's `ffmpeg` package via `FFMPEG_PATH=/usr/bin/ffmpeg`. License texts
  ship in the image under `/usr/share/doc/ffmpeg/`. Corresponding source is
  published by Debian: `apt-get source ffmpeg` against the image's release,
  or <https://snapshot.debian.org/> for the exact package version
  (`dpkg -s ffmpeg` inside the image names it). The
  `ffmpeg-static`/`ffprobe-static` npm download binaries are deleted in the
  shared `runtime` stage, so this image distributes Debian's build and no
  other.
- **Published api image** (`infra/Dockerfile`, target `api`): ships no ffmpeg
  at all. It does not invoke one, and it carries no `ffmpeg-static`.

  This statement depends on where the `ffmpeg-static`/`ffprobe-static` deletion
  sits in `infra/Dockerfile`. `npm ci` at the shared `runtime` stage downloads
  those binaries into `node_modules/` for every target built from it, so the
  deletion belongs to `runtime` — not to `worker` alone, which leaves the api
  image distributing a GPL ffmpeg build it never calls. If that `rm -rf` is
  ever moved back into a single target, this paragraph stops being true and the
  api image becomes a GPL distribution.
- **Development fallback** (`ffmpeg-static` npm package, MIT): its
  postinstall downloads a GPL ffmpeg build from the johnvansickle.com static
  builds (sources: <https://www.ffmpeg.org/download.html> and the build
  notes shipped beside each binary). This binary stays on the developer's
  machine; no KINO artifact redistributes it. Set `FFMPEG_PATH` (or run
  `npm ci --ignore-scripts`) to avoid the download entirely — see
  `docs/DEVELOPMENT.md`.

Issue #22 records the analysis.

## ESP-Hosted coprocessor partition table (Espressif, Apache-2.0)

`firmware/c6/partitions_eh_cp_ota_4m.csv` is Espressif's, copied verbatim from
`espressif/esp_hosted` 3.0.6 (ESP Component Registry),
`examples/mcu_hosted_sdio_sdmmc_combined/cp/partitions_eh_cp_ota_4m.csv`.

It is copied rather than referenced because IDF resolves
`CONFIG_PARTITION_TABLE_CUSTOM_FILENAME` against the project directory, and
`managed_components/` is generated rather than committed — so a build from a
clean checkout would not find it.

Apache-2.0, whose text is in `LICENSES/Apache-2.0.txt`. The file keeps its
upstream SPDX header, and `REUSE.toml` overrides the blanket MIT declaration
covering `firmware/**` so that Espressif's file is not relabelled as ours. The
offsets in it are the coprocessor's OTA contract; it is not edited.

The ESP-Hosted component itself is a build-time dependency resolved into
`managed_components/`, not redistributed source, and is pinned to an exact
version in `firmware/c6/main/idf_component.yml` with its resolved hash in
`firmware/c6/dependencies.lock`.

## W95FA typeface (Alina Sava, OFL-1.1)

`apps/prusa-print-98/public/fonts/w95fa.woff2` is W95FA, Alina Sava's modern
recreation of the Windows 95 user-interface typeface, under the SIL Open Font
License 1.1. It is what KINO Print's Windows 98 styling is actually set in.

Unlike the traced Roboto outlines the field body engraves — which are
outlines, not font software — **this is the font software, and it ships**: in
the app's Vite bundle and in the packaged Windows build. The OFL permits that.
What it does not permit is shipping it without its notice, so
`W95FA-NOTICE.txt` and `W95FA-OFL.txt` sit beside the file, and `REUSE.toml`
overrides the blanket MIT declaration covering `apps/**` so the typeface is
not relabelled as ours. The licence text is in `LICENSES/OFL-1.1.txt`.

Two obligations the OFL attaches, stated rather than assumed: the Reserved
Font Name must not be used for a modified version, so a subset or a
re-hinted build cannot keep the name W95FA; and the licence and notice travel
with any redistribution, including the packaged `.exe`, which bundles the
`.woff2` inside its resources.

Source: <https://www.dafont.com/W95FA.font>.

## Inter and Oxanium (OFL-1.1)

`firmware/p4/main/ui_font.h` is the camera's type, rasterised to 8-bit
coverage by `tools/mkfont.swift` for ASCII 32..126 at the five sizes `ui.c`
puts on the screen.

Two faces, with two jobs:

- **Inter** (Copyright 2016 The Inter Project Authors, `rsms/inter`, v4.1)
  carries everything a person reads as language - the list rows, the values,
  the sentences.
- **Oxanium** (Copyright 2019 The Oxanium Project Authors, `sevmeyer/oxanium`)
  carries everything the camera says as a machine - the screen titles, the
  technical caps, the word on the menu card.

Both are under the SIL Open Font License 1.1, kept as `LICENSES/OFL-1.1.txt`.
The header is a derivative of the fonts, which the OFL permits, and stays
under the OFL; the Reserved Font Name clause does not apply because the
derivative is not distributed under either font's name. The font software
itself is not redistributed - only the rasterised glyphs, which is what the
firmware and the Twin's WebAssembly build both embed.

The camera previously set its interface in a 1-bit rendering of Tahoma, baked
through a headless browser, and its menu in Windows 98 shell icons for which
no licence was held. Both are gone - the type is these two faces and the menu
is drawn - and issue #134 closes with them. The one baked raster left in the
interface is the studio's mark, below, and that one is baked because it is a
drawing and not a shape a program should be guessing at.

## The Odd Jobs mark (reserved)

`firmware/p4/main/logo_odd_jobs.h` is the mark of Odd Jobs, the studio that
makes this camera. `tools/mklogo.swift` bakes it from the studio's artwork
into a 160x160 8-bit coverage map, which `ui.c` samples bilinearly - once at
the centre of the boot bloom, once at the foot of the ABOUT screen.

It is a trade mark, not source. `firmware/**` is declared MIT and that grant
does not reach it: REUSE.toml marks the header `LicenseRef-KINO-Reserved`, the
same terms the KINO wordmarks carry, and that annotation records ownership
without granting anything. Anyone distributing a build of this firmware is
distributing the studio's mark with it, and needs the studio's permission to
do so under their own name.
