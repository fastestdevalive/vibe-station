import { Fragment } from "react";
import { Dialog } from "@/components/dialogs/Dialog";
import "@/styles/keyboard-shortcuts-dialog.css";

interface KeyboardShortcutsDialogProps {
  open: boolean;
  onClose: () => void;
}

interface ShortcutDef {
  keys: string[];
  action: string;
}

interface ShortcutGroup {
  title: string;
  shortcuts: ShortcutDef[];
}

/** True on macOS so we can show ⌘/⌥ glyphs instead of Ctrl/Alt. */
function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPod|iPad/i.test(navigator.platform ?? navigator.userAgent);
}

/** Render a shortcut as its platform-aware key combos. */
function KeyCombo({ combo }: { combo: string }) {
  const mac = isMac();
  const modMap: Record<string, string> = mac
    ? { Ctrl: "⌘", Shift: "⇧", Alt: "⌥" }
    : { Cmd: "Ctrl" };
  const parts = combo.split("+").map((part) => modMap[part] ?? part);
  return (
    <span className="shortcut-dialog__combo-parts">
      {parts.map((part, i) => (
        <span key={i} className="shortcut-dialog__combo-part">
          {i > 0 && <span className="shortcut-dialog__combo-sep">+</span>}
          <kbd className="shortcut-dialog__kbd">{part}</kbd>
        </span>
      ))}
    </span>
  );
}

const GROUPS: ShortcutGroup[] = [
  {
    title: "Navigation",
    shortcuts: [
      { keys: ["Ctrl+P"], action: "Quick-open files" },
      { keys: ["Ctrl+Shift+F"], action: "Files tab" },
    ],
  },
  {
    title: "Layout",
    shortcuts: [
      { keys: ["Ctrl+B", "Ctrl+\\"], action: "Toggle tool panel" },
      { keys: ["Ctrl+E"], action: "Toggle file tree" },
      { keys: ["Ctrl+/"], action: "Toggle split orientation" },
      { keys: ["Ctrl+Shift+Z"], action: "Toggle terminal dock" },
    ],
  },
  {
    title: "Agents & Worktrees",
    shortcuts: [
      { keys: ["Alt+N"], action: "New agent" },
      { keys: ["Alt+Shift+N"], action: "New worktree" },
      { keys: ["Ctrl+Shift+G"], action: "New agent" },
      { keys: ["Ctrl+Shift+M"], action: "New worktree" },
    ],
  },
];

export function KeyboardShortcutsDialog({ open, onClose }: KeyboardShortcutsDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      cardClassName="dialog-card--shortcuts"
    >
      <div className="shortcut-dialog__groups">
        {GROUPS.map((group) => (
          <Fragment key={group.title}>
            <div className="shortcut-dialog__group-title">{group.title}</div>
            <table className="shortcut-dialog__table">
              <tbody>
                {group.shortcuts.map((sc, i) => (
                  <tr key={i}>
                    <td className="shortcut-dialog__action">{sc.action}</td>
                    <td className="shortcut-dialog__keys">
                      <span className="shortcut-dialog__combo-list">
                        {sc.keys.map((k) => (
                          <KeyCombo key={k} combo={k} />
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Fragment>
        ))}
      </div>
    </Dialog>
  );
}
