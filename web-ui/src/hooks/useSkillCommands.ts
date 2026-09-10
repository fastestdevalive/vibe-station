import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { Command } from "@/api/types";

/**
 * Loads the user skill catalog for SkillEditor autocomplete in agent-creation
 * dialogs. Owns editorReady/editorSeq (Lexical mount gating) alongside the
 * commands fetch so every dialog gets identical behaviour from one place.
 *
 * Rules:
 * - editorReady=false while dialog is closed → SkillEditor unmounts, clearing
 *   Lexical state so the next open starts fresh with the restored draft.
 * - editorSeq bumps on each open → fresh editorKey → Lexical seeds content
 *   from initialText exactly once per mount (re-seeding a live editor is
 *   unreliable in Lexical).
 * - skillCommands=undefined while loading → SkillEditor shows no popover
 *   rather than an empty one.
 */
export function useSkillCommands(open: boolean, api: ApiInstance) {
  const [skillCommands, setSkillCommands] = useState<Command[] | undefined>(undefined);
  const [editorSeq, setEditorSeq] = useState(0);
  const [editorReady, setEditorReady] = useState(false);

  useEffect(() => {
    if (!open) {
      setEditorReady(false);
      setSkillCommands(undefined);
      return;
    }
    setEditorReady(true);
    setEditorSeq((n) => n + 1);
    let cancelled = false;
    void (async () => {
      try {
        const skills = await api.getSkills();
        if (!cancelled) {
          setSkillCommands(
            skills.skills.map(({ name, description, argumentHint }) => ({
              name,
              description,
              argumentHint,
            })),
          );
        }
      } catch {
        // Skills unavailable — popover stays disabled, typing still works.
      }
    })();
    return () => { cancelled = true; };
  }, [open, api]);

  return { skillCommands, editorSeq, editorReady };
}
