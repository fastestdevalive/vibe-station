import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { ApiInstance } from "@/api";
import type { DraftConfig, Session } from "@/api/types";
import type { SkillEditorHandle } from "@/components/chat/SkillEditor";
import { readBuffer } from "./buffer";
import { GLOBAL_NEW_SCOPE } from "./constants";
import { engineFor } from "./engine";
import { legacyTextFor } from "./migrateLegacy";
import { useDraftText } from "./useDraftText";

/** How many of our own sent prompts we remember to recognise their echoes. */
const SENT_RING = 8;

type UpdateDraftBody = Parameters<ApiInstance["updateDraft"]>[1];
type UpdateDraftResult = Awaited<ReturnType<ApiInstance["updateDraft"]>>;

interface Pair {
  draftPrompt: string;
  draftConfig?: DraftConfig;
}

/** Order-insensitive config identity, so a re-save with the same config dedupes. */
function configKey(config?: DraftConfig): string {
  if (!config) return "";
  const keys = Object.keys(config).sort();
  return JSON.stringify(keys.map((k) => [k, (config as unknown as Record<string, unknown>)[k]]));
}

function samePair(a: Pair, b: Pair): boolean {
  return a.draftPrompt === b.draftPrompt && configKey(a.draftConfig) === configKey(b.draftConfig);
}

/** The Tier-2 first paint, read synchronously (buffer → server doc → legacy). */
export function globalDraftInitialText(api: ApiInstance): string {
  const engine = engineFor(api);
  if (engine) return engine.initialText(GLOBAL_NEW_SCOPE);
  return readBuffer(GLOBAL_NEW_SCOPE)?.text ?? legacyTextFor(GLOBAL_NEW_SCOPE);
}

export interface DraftComposerSyncArgs {
  api: ApiInstance;
  /** Tier 1 (a server draft session) or Tier 2 (the `global-new` scope). */
  isTier1: boolean;
  draftSessionId: string | null;
  /** The Tier-1 session record (null for Tier 2). */
  session: Session | null;
  prompt: string;
  setPrompt: (text: string) => void;
  editorRef: RefObject<SkillEditorHandle | null>;
  currentConfig: DraftConfig;
}

export interface DraftComposerSync {
  /** `api.updateDraft`, deduped against the last sent pair (Decision 11). */
  updateDraft(id: string, body: UpdateDraftBody, opts?: { keepalive?: boolean }): Promise<UpdateDraftResult>;
}

/**
 * Live draft sync for `DraftComposer` (Decisions 10 + 11).
 *
 * Tier 2 binds the server-owned `global-new` scope: typing saves there (debounced
 * by the engine) and a remote change is applied to the editor; `globalDraftMirror`
 * keeps the sidebar's store in step and clears the scope on discard.
 *
 * Tier 1 has no `draft_texts` row — its draft lives on the session record, pushed
 * by `session:updated`. Own PATCH echoes arrive out of order and every keystroke
 * writes `applySessionUpdated`, so text equality alone would misfire: the wrapper
 * remembers the last sent `{draftPrompt, draftConfig}` (and the last 8 prompts),
 * ignores echoes, applies a remote prompt only while the local text is clean, and
 * skips a re-save that would send the same pair (which is what the config effect
 * at DraftComposer.tsx would otherwise PATCH right after a remote apply).
 */
export function useDraftComposerSync({
  api,
  isTier1,
  draftSessionId,
  session,
  prompt,
  setPrompt,
  editorRef,
  currentConfig,
}: DraftComposerSyncArgs): DraftComposerSync {
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const configRef = useRef(currentConfig);
  configRef.current = currentConfig;

  // The last pair we sent (or applied from the server). Seeded with the first
  // paint so a mount-time config flush does not re-send what the server has.
  const lastPairRef = useRef<Pair | null>(null);
  if (lastPairRef.current === null) lastPairRef.current = { draftPrompt: prompt, draftConfig: currentConfig };
  const sentPromptsRef = useRef<string[]>([]);

  const tier2 = useDraftText(api, isTier1 ? null : GLOBAL_NEW_SCOPE, {
    onRemote: (text) => {
      setPrompt(text);
      editorRef.current?.setText(text);
    },
  });

  // Tier 2: save only an actual edit. The mount run is not an edit — the first
  // paint is already the server's/legacy's text — and saving it before the
  // engine's fetch lands is what wiped the synced prompt (F-01).
  const savedPromptRef = useRef(prompt);
  const tier2Save = tier2.save;
  useEffect(() => {
    if (isTier1) return;
    if (prompt === savedPromptRef.current) return;
    savedPromptRef.current = prompt;
    tier2Save(prompt);
  }, [isTier1, prompt, tier2Save]);

  // Tier 2: flush the debounced save when the composer goes away. Depends on the
  // stable method (never on the binding object, which changes per render — F-03).
  const tier2Flush = tier2.flush;
  useEffect(() => {
    if (isTier1) return;
    return () => tier2Flush();
  }, [isTier1, tier2Flush]);

  // Tier 1: apply another client's prompt when this editor is clean.
  const incoming = session?.draftPrompt ?? "";
  useEffect(() => {
    if (!isTier1 || !draftSessionId) return;
    const pair = lastPairRef.current;
    if (!pair) return;
    if (incoming === promptRef.current) return; // our own live edit, echoed back
    if (sentPromptsRef.current.includes(incoming)) return; // an out-of-order own echo
    if (promptRef.current !== pair.draftPrompt) return; // unsent local edit wins
    pair.draftPrompt = incoming;
    pair.draftConfig = configRef.current;
    setPrompt(incoming);
    editorRef.current?.setText(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming, isTier1, draftSessionId]);

  const updateDraft = useCallback(
    (id: string, body: UpdateDraftBody, opts?: { keepalive?: boolean }): Promise<UpdateDraftResult> => {
      const pair: Pair = {
        draftPrompt: body.draftPrompt ?? promptRef.current,
        draftConfig: body.draftConfig ?? lastPairRef.current?.draftConfig,
      };
      const previous = lastPairRef.current;
      if (!id || (previous && samePair(pair, previous))) {
        return Promise.resolve({ ok: true, name: null } as UpdateDraftResult);
      }
      lastPairRef.current = pair;
      const ring = sentPromptsRef.current;
      ring.push(pair.draftPrompt);
      if (ring.length > SENT_RING) ring.shift();
      // A failed PATCH must not count as sent: restore the previous pair so the
      // unmount/pagehide flush re-sends it instead of deduping it away (F-06).
      return api.updateDraft(id, body, opts).catch((e) => {
        if (lastPairRef.current === pair) lastPairRef.current = previous;
        throw e;
      });
    },
    [api],
  );

  return { updateDraft };
}
