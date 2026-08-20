/**
 * How long a deleted capture remains recoverable before the worker permanently
 * removes its database rows and stored objects (Roll spec 03 §11).
 *
 * This belongs in the shared contract package because both the API (which tells
 * the host the purge deadline) and the worker (which enforces it) must use the
 * same value. A duplicated literal can make the UI promise more recovery time
 * than the purge process actually allows.
 */
export const TRASH_GRACE_DAYS = 7;

export const TRASH_GRACE_MS = TRASH_GRACE_DAYS * 24 * 60 * 60 * 1000;
