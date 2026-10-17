import { Fragment } from "react";
import { Kbd, type HintItem } from "../chat/ComposerShell";

/**
 * The draft composer's shortcut hint row, rendered as whole items with spacing
 * and no " · " separators (W1/W4 `.hint{display:flex;gap:14px}`), so a wrapped
 * line always starts and ends on a complete item. The shared `ComposerHint`
 * emits bare " · " text nodes that CSS cannot keep with an item, which left a
 * dangling "·" at the end of a wrapped line (R2F-03).
 */
export function DraftHint({ items, showDrop }: { items: HintItem[]; showDrop: boolean }) {
  return (
    <>
      {showDrop ? (
        <span className="chat-composer__hint-item">
          <span aria-hidden>⤓</span> Drop files here
        </span>
      ) : null}
      {items.map((item, i) => (
        <span className="chat-composer__hint-item" key={`${item.label}-${i}`}>
          {item.keys.map((k, j) => (
            <Fragment key={k}>
              {j > 0 ? " or " : null}
              <Kbd>{k}</Kbd>
            </Fragment>
          ))}{" "}
          {item.label}
        </span>
      ))}
    </>
  );
}
