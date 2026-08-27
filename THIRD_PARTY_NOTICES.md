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

## Windows XP icon artwork (Microsoft, no licence held)

`firmware/p4/main/icons_xp.h` contains six icons from the Microsoft Windows XP
(Luna) user interface set, baked to a 48x48 grid by
`scripts/bake-xp-icons.mjs` from the `softwarehistorysociety/XPIcons`
collection at commit `3887f201`. They are the P4 home screen's six tiles:
`DigitalCamera`, `SmartScreen`, `MyPictures`, `DialUpConnection`,
`SettingsAlert` and `MSN`.

The artwork is Microsoft's. **KINO holds no licence to redistribute it**, and
the upstream collection is an archive rather than a grant. `REUSE.toml` maps
the header to `LicenseRef-Microsoft-Proprietary` so that the MIT declaration
covering `firmware/**` does not extend to it; that annotation states the
ownership and grants nothing.

Consequences, stated plainly rather than deferred:

- A firmware binary built from this tree embeds the artwork. Publishing that
  binary is redistribution.
- Downscaling to 48 px and re-rendering it does not make it a new work. It is
  the same icon, smaller.
- The two ways out are a licence from Microsoft, or original artwork drawn for
  this product in the same idiom.

Issue #134 records the decision and must be resolved before a release carries
these files.
