// One version, from one place.
//
// `APP_VERSION` was the hardcoded string '1.0.0' in App.tsx while
// apps/studio/package.json said 0.9.1, so the About dialog, the menu bar and
// the connect screen all announced a release that does not exist. It is now
// stamped from the package version at build time (`__APP_VERSION__`, defined
// in vite.config.ts), which is the number `npm run version:check` polices.
//
// Its own module because the session layer needs it for HELLO and App.tsx
// imports the session — reading it off App would be a cycle.

export const APP_VERSION: string = __APP_VERSION__;

/** What the device's log calls this peer (04 §4), with the version it is. */
export const CLIENT_VERSION = `kino-studio/${APP_VERSION}`;
