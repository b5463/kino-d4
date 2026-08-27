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
  (`dpkg -s ffmpeg` inside the image names it). The image deletes the
  `ffmpeg-static`/`ffprobe-static` npm download binaries so it distributes
  no other ffmpeg build.
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

## Windows 98 icon artwork (Microsoft, no licence held)

`firmware/p4/main/icons_w98.h` contains seven icons from the Microsoft Windows
98 shell, baked at their native 48x48 or 32x32 by `scripts/bake-w98-icons.mjs`
from the `trapd00r/win95-winxp_icons` collection at commit `728a866a`, each
verified by SHA-256. They are the six menu tiles - `w98_multimedia`,
`w98_color_profile`, `w98_directory_pictures`, `w98_camera3_network`,
`w98_settings_gear` and `w98_shut_down_normal` - plus the viewfinder battery,
`w98_battery`.

The artwork is Microsoft's. **KINO holds no licence to redistribute it**, and
the upstream collection is an archive rather than a grant. `REUSE.toml` maps
the header to `LicenseRef-Microsoft-Proprietary` so that the MIT declaration
covering `firmware/**` does not extend to it; that annotation states the
ownership and grants nothing.

Consequences, stated plainly rather than deferred:

- A firmware binary built from this tree embeds the artwork. Publishing that
  binary is redistribution.
- The icons are stored at their original size and scaled by an integer factor
  at runtime, so what ships is a faithful reproduction rather than a
  derivation. That makes the position clearer, not weaker.
- The two ways out are a licence from Microsoft, or original artwork drawn for
  this product in the same idiom.

Issue #134 records the decision and must be resolved before a release carries
these files.
