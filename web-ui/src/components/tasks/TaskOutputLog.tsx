import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import { ApiError } from "@/api/errors";
import type { TaskOutput, TaskSummary } from "@/api/types";
import { StreamingMarkdown } from "@/components/chat/StreamingMarkdown";
import { cleanLines } from "./outputClean";
import { formatAge, toMs } from "./taskFormat";

export const OUTPUT_DEBOUNCE_MS = 500;
export const OUTPUT_TAIL_LINES = 200;
export const OUTPUT_UNAVAILABLE_COPY = "Output isn't available for this task from the current agent version.";

type Load = { kind: "loading" } | { kind: "ok"; out: TaskOutput } | { kind: "unavailable" } | { kind: "error" };

interface Props {
  api: ApiInstance;
  sessionId: string;
  task: TaskSummary;
  /** Reports the lines currently shown (raw), for Copy output. */
  onShownChange?: (lines: string[]) => void;
  /** Current time (ms) from the caller's tick; this component owns no timers. */
  now: number;
  /** True when the caller ticks every second, so "last output Ns ago" is live. Otherwise ages < 1 min read "<1m". */
  secondPrecision: boolean;
  /** Icon buttons rendered at the right end of the toolbar (Copy / Stop). */
  actions?: ReactNode;
}

/**
 * Output pane of the task view. Fetches on open and again (500 ms trailing debounce, at most one request
 * in flight) whenever the task's `outputRev` or `state` changes or the connection comes back. No timers
 * run while nothing changes.
 */
export function TaskOutputLog({ api, sessionId, task, onShownChange, now, secondPrecision, actions }: Props) {
  const followId = useId();
  const wrapId = useId();
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [shown, setShown] = useState<Load>({ kind: "loading" });
  const [held, setHeld] = useState<TaskOutput | null>(null);
  const [reconnects, setReconnects] = useState(0);
  const preRef = useRef<HTMLDivElement>(null);

  const noOutput = task.outputKind === "none";
  const taskId = task.id;
  const { outputRev, state } = task;

  // ── fetch machinery (refs: handlers must see the CURRENT task, not the one that started the request)
  const current = useRef({ taskId, outputRev, state, sessionId, follow });
  current.current = { taskId, outputRev, state, sessionId, follow };
  const inFlight = useRef(false);
  const again = useRef(false);
  const loadedFor = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const shownRef = useRef<Load>(shown);
  shownRef.current = shown;
  const apiRef = useRef(api);
  apiRef.current = api;

  const run = useCallback(() => {
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    const asked = { ...current.current };
    loadedFor.current = `${asked.sessionId}/${asked.taskId}`;
    apiRef.current
      .getTaskOutput(asked.sessionId, asked.taskId, OUTPUT_TAIL_LINES)
      .then(
        (out) => ({ ok: true as const, out }),
        (e: unknown) => ({ ok: false as const, e }),
      )
      .then((res) => {
        inFlight.current = false;
        if (!alive.current) return;
        const cur = current.current;
        // Only a different task/session invalidates a reply. A reply for an older rev is still newer than what is
        // on screen, and the queued trailing refetch picks up the latest (discarding it would starve a busy log).
        const stale = cur.taskId !== asked.taskId || cur.sessionId !== asked.sessionId;
        if (!stale) {
          if (res.ok) {
            const prev = shownRef.current;
            if (cur.follow || prev.kind !== "ok") {
              setShown({ kind: "ok", out: res.out });
              setHeld(null);
            } else if (res.out.lines.join("\n") !== prev.out.lines.join("\n") || res.out.finalText !== prev.out.finalText) {
              setHeld(res.out);
            }
          } else if (res.e instanceof ApiError && (res.e.status === 404 || res.e.status === 409)) {
            setShown({ kind: "unavailable" });
          } else {
            setShown((prev) => (prev.kind === "ok" ? prev : { kind: "error" }));
          }
        }
        if (again.current) {
          again.current = false;
          run();
        }
      });
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // Reset when switching to another task.
  useEffect(() => {
    setShown({ kind: "loading" });
    setHeld(null);
    setFollow(true);
    again.current = false;
  }, [sessionId, taskId]);

  useEffect(() => {
    if (noOutput) {
      setShown({ kind: "unavailable" });
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (loadedFor.current !== `${sessionId}/${taskId}`) {
      run();
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      run();
    }, OUTPUT_DEBOUNCE_MS);
  }, [sessionId, taskId, outputRev, state, reconnects, noOutput, run]);

  // Refetch when the connection returns online (the daemon's replay resends a snapshot, but output is REST).
  useEffect(() => {
    let prev: string | undefined;
    return api.subscribeConnection((s) => {
      if (s === "online" && prev !== undefined && prev !== "online") setReconnects((n) => n + 1);
      prev = s;
    });
  }, [api]);

  const out = shown.kind === "ok" ? shown.out : null;
  const lines = out ? out.lines.slice(-OUTPUT_TAIL_LINES) : [];
  useEffect(() => {
    onShownChange?.(lines);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [out]);

  useLayoutEffect(() => {
    const el = preRef.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [follow, out]);

  const cleaned = cleanLines(lines);
  const isSub = task.kind === "subagent";
  const lastMs = toMs(task.lastActivityAt);

  let body;
  if (shown.kind === "loading") {
    body = <div className="task-log__empty">Loading output…</div>;
  } else if (shown.kind === "unavailable") {
    body = (
      <div className="task-log__empty" data-testid="task-output-empty">
        {OUTPUT_UNAVAILABLE_COPY}
      </div>
    );
  } else if (shown.kind === "error") {
    body = <div className="task-log__empty">Couldn't load the output yet.</div>;
  } else if (isSub) {
    body = (
      <div className="task-log__events" ref={preRef} data-testid="task-output">
        {cleaned.length === 0 && !out?.finalText ? <div className="task-log__empty">No activity yet.</div> : null}
        {cleaned.length > 0 ? (
          <ul className="task-log__list">
            {cleaned.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        ) : null}
        {out?.finalText ? (
          <div className="task-log__final" data-testid="task-final-text">
            <div className="task-log__final-title">Final message</div>
            <StreamingMarkdown source={out.finalText} api={api} />
          </div>
        ) : null}
      </div>
    );
  } else {
    body = (
      <div className="task-log__scroll" ref={preRef}>
        {cleaned.length === 0 ? (
          <div className="task-log__empty">No output yet.</div>
        ) : (
          <pre className={`task-log__pre${wrap ? " task-log__pre--wrap" : ""}`} data-testid="task-output">
            {cleaned.join("\n")}
          </pre>
        )}
      </div>
    );
  }

  return (
    <section className="task-log" aria-label={isSub ? "Task activity" : "Task output"}>
      <div className="task-log__toolbar">
        <span className="task-log__title">{isSub ? "Activity" : "Output"}</span>
        {!isSub ? <span>stdout + stderr</span> : null}
        <span className="task-log__spacer" />
        {held ? (
          <button
            type="button"
            className="task-log__resume"
            onClick={() => {
              setShown({ kind: "ok", out: held });
              setHeld(null);
              setFollow(true);
            }}
          >
            New output — Resume follow
          </button>
        ) : null}
        <label htmlFor={followId} className="task-log__check">
          <input
            id={followId}
            type="checkbox"
            checked={follow}
            onChange={(e) => {
              setFollow(e.target.checked);
              if (e.target.checked && held) {
                setShown({ kind: "ok", out: held });
                setHeld(null);
              }
            }}
          />
          Follow
        </label>
        {!isSub ? (
          <label htmlFor={wrapId} className="task-log__check">
            <input id={wrapId} type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
            Wrap lines
          </label>
        ) : null}
        {actions ? <div className="task-log__actions">{actions}</div> : null}
      </div>
      {body}
      {task.outputKind === "file" ? (
        <div className="task-log__footer" data-testid="task-log-footer">
          <span>
            Last {OUTPUT_TAIL_LINES} lines
            {lastMs !== undefined ? ` · last output ${!secondPrecision && now - lastMs < 60_000 ? "<1m" : formatAge(now - lastMs)} ago` : ""}
          </span>
        </div>
      ) : null}
    </section>
  );
}
