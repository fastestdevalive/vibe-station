#!/usr/bin/env python3
"""Hermetic stand-in for `agy --input-format stream-json`.

Never talks to the network, never needs a login. Modelled on the REAL agy
1.4.7 behaviour:

- startup takes ~0.2 s, then one `init` line is printed;
- an unknown `--conversation <id>` prints
  `warning: conversation "<id>" not found` to stderr and inits a DIFFERENT id;
- an id the fake itself minted (`conv-new-0001`, `conv-fresh-0001`) counts as
  known, so a respawn with `--conversation conv-new-0001` succeeds;
- stdin accepts only `{"event":"user",...}`; each one consumes the next
  scenario entry;
- SIGINT prints `error: interrupted` to stderr, then a REAL-shaped
  `result{status:"ERROR", error:"interrupted", response:<partial>}` and exits 1.

Configuration (all via env, all optional except the two logs):

  FAKE_AGY_ARGV_LOG   append one {"argv":[…],"cwd":…} JSON line per spawn
  FAKE_AGY_PID_FILE   write this process's pid at startup
  FAKE_AGY_USER_LOG   append every received user event line (also the scenario
                      cursor: the entry index is the number of lines already in
                      this file, so a respawned fake continues the list)
  FAKE_AGY_SCENARIO   comma list of fixture paths or HANG / EXIT; last repeats
  FAKE_AGY_KNOWN      comma list of extra known conversation ids
                      (default: conv-known-0001)
  FAKE_AGY_TRANSCRIPT fixture name (under tests/fixtures/); when set, the
                      fake writes it as the REAL agy does — before the tool
                      steps are streamed — to
                      $HOME/.gemini/antigravity-cli/brain/<conv>/
                      .system_generated/logs/transcript_full.jsonl
                      (file tool events on stdout carry only `Path`, exactly
                      like agy 1.4.7; the arguments live in that transcript).
                      Like real agy, an edit_file call is followed by a GENERIC
                      result row (`Made N replacement(s) in <path> starting at
                      line L …`) whose step_index equals the stream tool step.
                      `__HOME__` in a fixture (transcript or scenario) is
                      replaced by $HOME so tests can point edits at real files.
"""

import json
import os
import signal
import sys
import time

MINTED_IDS = ("conv-new-0001", "conv-fresh-0001")
DEFAULT_KNOWN = ("conv-known-0001",)

current_id = "conv-new-0001"
argv = []


def out(line):
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def err(line):
    sys.stderr.write(line + "\n")
    sys.stderr.flush()


def step_update(step_index, state, step_type, **extra):
    step = {
        "conversation_id": current_id,
        "step_index": step_index,
        "state": state,
        "step_type": step_type,
    }
    step.update(extra)
    out(json.dumps({"event": "step_update", "step_update": step}))


def on_sigint(_signum, _frame):
    err("error: interrupted")
    out(
        json.dumps(
            {
                "event": "result",
                "result": {
                    "conversation_id": current_id,
                    "status": "ERROR",
                    "response": "partial ",
                    "error": "interrupted",
                    "duration_seconds": 0.02,
                    "num_turns": 1,
                    "usage": {
                        "input_tokens": 7541,
                        "output_tokens": 12,
                        "thinking_tokens": 3,
                        "cache_read_tokens": 0,
                        "total_tokens": 7556,
                    },
                },
            }
        )
    )
    sys.exit(1)


def parse_argv(argv):
    conversation = None
    model = None
    for index, arg in enumerate(argv):
        if arg == "--conversation" and index + 1 < len(argv):
            conversation = argv[index + 1]
        elif arg == "--model" and index + 1 < len(argv):
            model = argv[index + 1]
    return conversation, model


def known_ids():
    ids = list(DEFAULT_KNOWN) + list(MINTED_IDS)
    extra = os.environ.get("FAKE_AGY_KNOWN", "")
    for item in extra.split(","):
        item = item.strip()
        if item:
            ids.append(item)
    return ids


def argv_log():
    path = os.environ.get("FAKE_AGY_ARGV_LOG")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"argv": argv, "cwd": os.getcwd()}) + "\n")


def user_log_lines(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return sum(1 for _ in handle)
    except FileNotFoundError:
        return 0


def scenario_entries():
    raw = os.environ.get("FAKE_AGY_SCENARIO", "")
    entries = [item.strip() for item in raw.split(",") if item.strip()]
    return entries


def write_transcript():
    name = os.environ.get("FAKE_AGY_TRANSCRIPT")
    home = os.environ.get("HOME")
    if not name or not home:
        return
    source = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", name)
    logs = os.path.join(
        home,
        ".gemini",
        "antigravity-cli",
        "brain",
        current_id,
        ".system_generated",
        "logs",
    )
    os.makedirs(logs, exist_ok=True)
    with open(source, "r", encoding="utf-8") as src:
        body = src.read().replace("__HOME__", home)
    with open(os.path.join(logs, "transcript_full.jsonl"), "w", encoding="utf-8") as dst:
        dst.write(body)


def run_scenario(entry):
    if entry == "HANG":
        step_update(1, "ACTIVE", "agent_response", text_delta="partial ")
        while True:
            time.sleep(0.05)
    if entry == "EXIT":
        err("fatal: signed out abcdefghij0123456789ABCDEFGHIJ0123456789")
        sys.exit(3)
    path = entry
    if not os.path.isabs(path):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", path)
    write_transcript()
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                out(
                    line.replace("__CONV__", current_id).replace(
                        "__HOME__", os.environ.get("HOME", "")
                    )
                )


def main():
    global current_id

    argv[:] = sys.argv[1:]
    argv_log()

    pid_file = os.environ.get("FAKE_AGY_PID_FILE")
    if pid_file:
        with open(pid_file, "w", encoding="utf-8") as handle:
            handle.write(str(os.getpid()))

    signal.signal(signal.SIGINT, on_sigint)

    conversation, _model = parse_argv(argv)
    time.sleep(0.2)

    if conversation is None:
        current_id = "conv-new-0001"
    elif conversation in known_ids():
        current_id = conversation
    else:
        err('warning: conversation "%s" not found' % conversation)
        # Real agy warns ~0.25 s before it inits (~3 s later). Keeping a gap
        # here makes "warning seen before init" deterministic for the agent.
        time.sleep(0.1)
        current_id = "conv-fresh-0001"

    out(
        json.dumps(
            {
                "event": "init",
                "conversation_id": current_id,
                "init": {"cwd": os.getcwd(), "tools": ["run_command", "view_file"]},
            }
        )
    )

    entries = scenario_entries()
    user_log = os.environ.get("FAKE_AGY_USER_LOG")

    for line in sys.stdin:
        if '"event":"user"' not in line and '"event": "user"' not in line:
            continue
        if user_log:
            index = user_log_lines(user_log)
            with open(user_log, "a", encoding="utf-8") as handle:
                handle.write(line if line.endswith("\n") else line + "\n")
        else:
            index = 0
        if entries:
            entry = entries[index] if index < len(entries) else entries[-1]
            run_scenario(entry)

    sys.exit(0)


if __name__ == "__main__":
    main()
