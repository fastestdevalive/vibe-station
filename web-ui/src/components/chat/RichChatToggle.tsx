interface RichChatToggleProps {
  /** ON = Rich Chat (`json`), OFF = Terminal (`tmux`). */
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Rich Chat unavailable for the selected CLI — the switch is forced off. */
  disabled?: boolean;
  /** Tooltip shown while disabled (why Rich Chat is unavailable). */
  disabledReason?: string;
}

/**
 * Composer-toolbar switch choosing a new agent's channel: ON = Rich Chat,
 * OFF = Terminal. "Rich Chat" in the UI, `json` in the code (AGENTS.md § UI
 * terminology) — the "(json based)" qualifier only appears in the tooltip.
 */
export function RichChatToggle({ checked, onChange, disabled, disabledReason }: RichChatToggleProps) {
  const on = checked && !disabled;
  const title = disabled
    ? (disabledReason ?? "Rich Chat isn't available for this agent — it will run in a Terminal")
    : on
      ? "Rich Chat (json based) — turn off to start a Terminal agent instead"
      : "Terminal agent — turn on for Rich Chat (json based)";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Rich Chat"
      title={title}
      className="chat-composer__channel-toggle"
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span className="chat-composer__switch-track" aria-hidden>
        <span className="chat-composer__switch-thumb" />
      </span>
      <span>{on ? "Rich Chat" : "Terminal"}</span>
    </button>
  );
}
