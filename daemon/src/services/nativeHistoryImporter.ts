/**
 * NativeHistoryImporter — read a CLI's *at-rest* native store and normalize its
 * terminal-phase turns into our `NormalizedEvent`s (R0.5–R0.9).
 *
 * This is the capability a later phase (P3 toggle) invokes on `tty→json` to
 * backfill the turns a user ran in the raw terminal — turns that never flowed
 * through the JSON `runTurn` normalization path and so are invisible in the JSON
 * UI. In P2 NOTHING calls the importer yet; it is a tested, wired-up capability.
 *
 * Each importer is a NEW at-rest envelope adapter, NOT a reuse of the live
 * stream parser (R0.6): the native store has no daemon-synthesized `user` event
 * and no synthetic `result` line, so the adapter (a) emits `user` events from the
 * native store's own user content and (b) derives usage from the native message.
 *
 * Availability is exposed via a per-CLI registry so P3 can GATE the toggle:
 * claude + opencode ship here; cursor + agy are DEFERRED (absent → blocked).
 */

import type { NormalizedEvent } from "../types.js";
import { claudeHistoryImporter } from "../agent-plugins/claudeImport.js";
import { opencodeHistoryImporter } from "../agent-plugins/opencodeImport.js";

/** Inputs to one import pass. */
export interface NativeImportRequest {
  /** OUR session id — stamped on every emitted `NormalizedEvent`. */
  sessionId: string;
  /** The harness chat/session id that locates the native store. */
  agentChatId: string;
  /** Session cwd (worktree/project path) — resolves the native store location. */
  cwd: string;
  /**
   * The native cursor watermark from the previous import — a per-CLI coordinate
   * (claude line index, opencode message timestamp), STORED SEPARATELY from our
   * `logSeq` (R0.5). Undefined ⇒ import from the beginning of the native store.
   */
  watermark?: string;
}

export interface NativeImportResult {
  /** Normalized events for every native turn PAST the watermark, in order. */
  events: NormalizedEvent[];
  /** The native cursor to persist for the next import (see `native_watermark`). */
  nextWatermark: string;
}

/** Per-CLI at-rest adapter. */
export interface NativeHistoryImporter {
  readonly cli: string;
  import(req: NativeImportRequest): Promise<NativeImportResult>;
}

/**
 * The importer registry — the P3 toggle GATE. A CLI present here can import its
 * terminal-phase history; a CLI absent here blocks the tty→json toggle (R1.6).
 * cursor + agy are DEFERRED and intentionally absent.
 */
const IMPORTERS: Record<string, NativeHistoryImporter> = {
  claude: claudeHistoryImporter,
  opencode: opencodeHistoryImporter,
};

/** Resolve the native-history importer for a CLI, or undefined if none exists. */
export function getNativeHistoryImporter(cli: string): NativeHistoryImporter | undefined {
  return IMPORTERS[cli];
}

/** Whether a CLI can import terminal-phase history (the P3 toggle gate). */
export function hasNativeHistoryImporter(cli: string): boolean {
  return cli in IMPORTERS;
}
