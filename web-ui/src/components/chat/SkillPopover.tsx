import { useEffect, useRef } from "react";
import type { Command } from "@/api/types";

interface SkillPopoverProps {
  items: Command[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (command: Command) => void;
  listboxId: string;
  popoverRef?: React.Ref<HTMLDivElement>;
}

/** `/`-triggered filtered skill popover, mounted above the composer textarea.
 *  Follows `NewAgentDialog.tsx`'s combobox prior art (`onMouseDown` +
 *  `preventDefault` so a click never blurs the textarea first) with two
 *  fixes over it: a pointer-moved guard before hover changes the active
 *  option (a scrollIntoView-triggered `mouseenter` at the same coordinates
 *  must not fight keyboard nav), and `scrollIntoView` on arrow nav. */
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
      {items.map((cmd, i) => (
        <button
          key={cmd.name}
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
      ))}
    </div>
  );
}
