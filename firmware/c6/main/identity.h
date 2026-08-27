// What this image calls itself on the console.
//
// KINO_C6_FW_VERSION is read from firmware/VERSION by main/CMakeLists.txt and
// never typed in by hand, so one repo version describes the P4, the four camera
// nodes and this coprocessor together.
//
// This is NOT the version the ESP-Hosted host checks. The coprocessor reports
// its own firmware and RPC version to the P4 over RPC, from inside the
// component; the string here only identifies which KINO commit produced the
// image. Both matter for a different reason — see the version-compatibility
// section of ../README.md.
#ifndef IDENTITY_H
#define IDENTITY_H

#define KINO_C6_ROLE "radio-coprocessor"
#define KINO_C6_FW_VERSION KINO_FW_VERSION

// Names the image, so a console line distinguishes this build from the factory
// image the board shipped with — which is the first thing to read at the bench
// and is expected to be older than this one.
#define KINO_C6_IMAGE "esp-hosted-cp-sdio"

// Fixed prefix, so a bench script or a future P4-side reader can match on it:
//
//   KINO-C6 fw=0.3.0 role=radio-coprocessor image=esp-hosted-cp-sdio
//
// Keys are stable; new keys are appended, never inserted.
#define KINO_C6_BANNER_PREFIX "KINO-C6"

#endif  // IDENTITY_H
