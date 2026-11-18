import { useEffect, useMemo, useReducer, useRef } from "react";
import type { ApiInstance } from "@/api";
import { readBuffer } from "./buffer";
import { engineFor, type DraftBinding } from "./engine";
import { legacyTextFor } from "./migrateLegacy";

/**
 * Bind one editor to a server-owned draft scope (Decision 9). `initialText` is a
 * synchronous first paint (buffer → server doc → legacy → ""); `onRemote` is
 * called whenever another client (or a sibling binding) changes the text. The
 * latest `onRemote` is read through a ref, so callers need not memoise it.
 *
 * With no engine (tests that never call `ensureDraftTextSync`) or a null scope,
 * every write is a no-op and the first paint is the sync local read.
 */
export function useDraftText(
  api: ApiInstance,
  scope: string | null,
  opts: { onRemote: (text: string) => void },
): DraftBinding {
  const onRemote = useRef(opts.onRemote);
  onRemote.current = opts.onRemote;
  const live = useRef<DraftBinding | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const engine = scope === null ? undefined : engineFor(api);

  const initialText =
    scope === null ? "" : engine ? engine.initialText(scope) : (readBuffer(scope)?.text ?? legacyTextFor(scope));

  useEffect(() => {
    if (scope === null || !engine) return;
    const binding = engine.bind(scope, (text) => onRemote.current(text));
    live.current = binding;
    return () => {
      live.current = null;
      binding.dispose();
    };
  }, [api, scope, engine]);

  useEffect(() => {
    if (engine || scope === null) return;
    // `ensureDraftTextSync` lives in a parent effect, and child effects run
    // first: the engine can appear right after this render. Bind then.
    const timer = setTimeout(() => {
      if (engineFor(api)) rerender();
    }, 0);
    return () => clearTimeout(timer);
  }, [api, scope, engine]);

  return useMemo<DraftBinding>(
    () => ({
      initialText,
      save: (text) => live.current?.save(text),
      flush: (opts2) => live.current?.flush(opts2),
      clear: () => live.current?.clear(),
      dispose: () => live.current?.dispose(),
    }),
    [initialText],
  );
}
