import type { TaskState } from "@/api/types";

/** Status glyph for a task: accent spinner only while live and not quiet; everything else static grey. */
export function TaskIcon({ state, quiet, size = 12, label = true }: { state: TaskState; quiet: boolean; size?: number; label?: boolean }) {
  const a11y = (name: string) => (label ? ({ role: "img", "aria-label": name } as const) : ({ "aria-hidden": true } as const));
  if (state === "running" && !quiet) {
    return (
      <svg className="task-spin" data-testid="task-spinner" width={size} height={size} viewBox="0 0 24 24" fill="none" {...a11y("Running")}>
        <circle cx="12" cy="12" r="9" className="task-spin__track" strokeWidth="3" />
        <path d="M12 3a9 9 0 0 1 9 9" className="task-spin__arc" strokeWidth="3" strokeLinecap="round" />
      </svg>
    );
  }
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    strokeWidth: 2.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "task-icon",
  };
  if (state === "running") {
    // quiet: static dashed ring
    return (
      <svg {...common} data-testid="task-icon-quiet" {...a11y("Quiet")}>
        <circle cx="12" cy="12" r="9" strokeDasharray="3 4" />
      </svg>
    );
  }
  if (state === "done") {
    return (
      <svg {...common} {...a11y("Done")}>
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  if (state === "failed" || state === "stopped") {
    return (
      <svg {...common} {...a11y(state === "failed" ? "Failed" : "Stopped")}>
        <line x1="6" y1="6" x2="18" y2="18" />
        <line x1="18" y1="6" x2="6" y2="18" />
      </svg>
    );
  }
  return (
    <svg {...common} {...a11y("Ended or unknown")}>
      <line x1="6" y1="12" x2="18" y2="12" />
    </svg>
  );
}
