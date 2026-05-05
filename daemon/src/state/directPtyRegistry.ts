// @ts-nocheck
/**
 * Registry of active direct-PTY streams.
 *
 * Direct-pty sessions (useTmux:false) are registered here at spawn time
 * and removed when the PTY exits. Stores one shared stream per session.
 *
 * Contrast with TmuxOutputStream, which is stored per-WSConnection
 * in connection.openStreams (one attach-session per tab).
 */

import type { SessionStream } from "../ws/streams/sessionStream.js";

export const directPtyRegistry = new Map<string, SessionStream>();
