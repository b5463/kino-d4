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
