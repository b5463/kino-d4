// What this image calls itself.
//
// KINO_C6_FW_VERSION is the string the P4 will hand back for KDP FW_QUERY
// (0x60) once the host link exists, so it is defined once, here, and read from
// firmware/VERSION by main/CMakeLists.txt — never typed in by hand. The P4 and
// the four camera nodes take their version from the same file, so one repo
// version describes the whole camera.
#ifndef IDENTITY_H
#define IDENTITY_H

#define KINO_C6_ROLE "radio-coprocessor"
#define KINO_C6_FW_VERSION KINO_FW_VERSION

// The boot banner is one line on UART0 with a fixed prefix, so a bench script
// or a future P4-side reader can match it without a parser:
//
//   KINO-C6 fw=0.3.0 role=radio-coprocessor mac=aa:bb:cc:dd:ee:ff link=not-routed aps=7
//
// Keys are stable; new keys are appended, never inserted.
#define KINO_C6_BANNER_PREFIX "KINO-C6"

#endif  // IDENTITY_H
