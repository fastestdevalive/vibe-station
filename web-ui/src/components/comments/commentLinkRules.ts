import { DRAFT_ID } from "./draftComment";

/** `id` as the body of a double-quoted CSS string (attribute values here are always quoted). */
const cssString = (id: string): string => id.replace(/[\\"]/g, "\\$&").replace(/[\n\r\f]/g, " ");

/**
 * Pin -> span link, pure CSS: one rule per comment lights its span marks (`--comment-hl-active`, tokens.css)
 * while its pin or one of its marks is hovered, or its pin is focused. The sheet only changes when the comment
 * set does, so hovering runs no script, sets no state and inserts no node. The pin itself never changes on
 * hover (no ring, no size change): it must stay exactly under the pointer so it can be clicked.
 */
export function linkRules(ids: readonly string[]): string {
  return ids
    .filter((id) => id !== DRAFT_ID)
    .map((id) => {
      const e = cssString(id);
      const pin = `[data-comment-pin="${e}"]`;
      const mark = `mark[data-comment-id="${e}"]`;
      return (
        `[data-comment-surface]:has(${pin}:hover,${pin}:focus,${mark}:hover) ` +
        `mark.comment-hl[data-comment-id="${e}"]{background:var(--comment-hl-active)}`
      );
    })
    .join("");
}
