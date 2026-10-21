import { useEffect, useRef, useState } from "react";
import { copyText } from "@/lib/copyText";
import { usePortalRoot } from "../../context/DemoEnv";
import "./doctor.css";

/**
 * A copyable shell command: `$ ` prompt + multi-line `<pre>` + a Copy button.
 * The text is selectable (`.cmd-block`) so it can also be copied by hand when
 * the clipboard is unavailable.
 */
export function CommandBlock({ command }: { command: string }) {
  const portalRoot = usePortalRoot();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const handleCopy = async () => {
    // Normal app: identical single-argument call; the portal root is only passed inside a demo.
    const ok =
      portalRoot !== document.body ? await copyText(command, portalRoot) : await copyText(command);
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), ok ? 1500 : 2000);
  };

  return (
    <div className="cmd-block">
      <span className="cmd-block__prompt" aria-hidden="true">
        $
      </span>
      <pre className="cmd-block__pre">{command}</pre>
      <button type="button" className="cmd-block__copy" onClick={() => void handleCopy()}>
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
      </button>
    </div>
  );
}
