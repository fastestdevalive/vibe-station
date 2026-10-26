import { Fragment, useEffect, useRef } from "react";
import type { ComposerCommand } from "@/api/types";
import { COMMAND_GROUP_LABELS, commandGroupRank } from "@/lib/composerCommands";

interface SkillPopoverProps {
  /** Already filtered AND stable-sorted by group rank (SkillEditor), so the
   *  rendered order is the keyboard order. */
  items: ComposerCommand[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (command: ComposerCommand) => void;
  listboxId: string;
  popoverRef?: React.Ref<HTMLDivElement>;
}

/** `/`-triggered filtered skill popover, mounted above the composer textarea.
 *  Follows `NewAgentDialog.tsx`'s combobox prior art (`onMouseDown` +
 *  `preventDefault` so a click never blurs the textarea first) with two
 *  fixes over it: a pointer-moved guard before hover changes the active
 *  option (a scrollIntoView-triggered `mouseenter` at the same coordinates
 *  must not fight keyboard nav), and `scrollIntoView` on arrow nav.
 *
 *  Group headers are inserted only where the group changes, so a flat catalog
 *  renders one header and a grouped one renders "Vibe Station", "Skills",
 *  "Agent commands" in rank order (plan requirement 11). */
export function SkillPopover({ items, activeIndex, onHover, onSelect, listboxId, popoverRef }: SkillPopoverProps) {
  const pointerMovedRef = useRef(false);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const el = optionRefs.current[activeIndex];
    // jsdom (test env) and very old browsers lack scrollIntoView — LeftSidebar.tsx:837-838 precedent.
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  return (
    <div
      ref={popoverRef}
      className="chat-skill-popover"
      role="listbox"
      id={listboxId}
      onMouseMove={() => {
        pointerMovedRef.current = true;
      }}
    >
      {items.map((cmd, i) => {
        const prev = i > 0 ? items[i - 1] : undefined;
        const showHeader = !prev || commandGroupRank(prev.group) !== commandGroupRank(cmd.group);
        return (
          <Fragment key={cmd.name}>
            {showHeader ? (
              <div role="presentation" className="chat-skill-popover__group">
                {COMMAND_GROUP_LABELS[cmd.group ?? "agent"] ?? COMMAND_GROUP_LABELS.agent}
              </div>
            ) : null}
            <button
              ref={(el) => {
                optionRefs.current[i] = el;
              }}
              type="button"
              role="option"
              tabIndex={-1}
              id={`${listboxId}-${i}`}
              aria-selected={activeIndex === i}
              className={`chat-skill-popover__option${activeIndex === i ? " chat-skill-popover__option--active" : ""}`}
              onMouseDown={(e) => {
                // Prevent the default focus-shift so the textarea never blurs.
                e.preventDefault();
                onSelect(cmd);
              }}
              onMouseEnter={() => {
                // Ignore a phantom mouseenter fired by scrollIntoView without
                // any real pointer movement — only a genuine mousemove arms this.
                if (pointerMovedRef.current) onHover(i);
              }}
            >
              <span className="chat-skill-popover__name" title={`/${cmd.name}`}>
                /{cmd.name}
              </span>
              {cmd.description ? (
                <span className="chat-skill-popover__desc" title={cmd.description}>
                  {cmd.description}
                </span>
              ) : null}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
