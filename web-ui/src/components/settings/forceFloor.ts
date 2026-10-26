/**
 * When the last forced update check was sent. Module-level so it survives
 * Settings remounts; an object so a test can reset it by assignment.
 */
export const forceFloor = { lastForcedAt: 0 };
