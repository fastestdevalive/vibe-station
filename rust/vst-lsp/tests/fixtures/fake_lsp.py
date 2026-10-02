#!/usr/bin/env python3
"""Fake LSP server for manager integration tests.

Driven by FAKE_LSP_MODE:
  - "die-after-init": responds to `initialize`, then exits immediately —
    simulating a server that aborts right after init (used for the dead-server
    detection / re-spawn test).
  - "stay-alive": responds to `initialize`, reads `initialized`, then loops
    reading requests, answering `textDocument/definition` with an empty array,
    and never sending `$/progress` (used for the settle / no-progress test).
  - "server-status-degraded": like "stay-alive", but on `initialized` sends
    rust-analyzer's `experimental/serverStatus` — first `quiescent: false`,
    then `quiescent: true` with `health: "warning"` — only if the client
    advertised `experimental.serverStatusNotification`.

  - "rpc-error-init": answers `initialize` with a JSON-RPC error
    ($FAKE_LSP_ERROR, default a generic message) and stays alive.
  - "exit-before-reply": writes to stderr and exits 1 on `initialize`
    without replying.
  - "never-reply": reads `initialize` and never answers.
  - "stderr-flood": writes ~1 MB to stderr BEFORE answering `initialize`,
    then behaves like "stay-alive" (back-pressure test: an undrained stderr
    pipe would block it forever).

Each invocation appends a line to the file at $FAKE_LSP_LOG (when set) so the
test can count how many distinct processes were spawned. The `initialize`
params' `initializationOptions` are appended as JSON to $FAKE_LSP_INIT_LOG
(when set).
"""

import json
import os
import sys


def send(obj):
    s = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(b"Content-Length: %d\r\n\r\n" % len(s) + s)
    sys.stdout.buffer.flush()


def read_msg():
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        if line in (b"\r\n", b"\n", b""):
            break
        if b":" in line:
            k, v = line.split(b":", 1)
            headers[k.strip().lower()] = v.strip()
    length = int(headers.get(b"content-length", 0) or 0)
    if length <= 0:
        return None
    body = sys.stdin.buffer.read(length)
    try:
        return json.loads(body)
    except Exception:
        return None


def log(msg):
    path = os.environ.get("FAKE_LSP_LOG")
    if path:
        with open(path, "a") as f:
            f.write(msg + "\n")


def main():
    mode = os.environ.get("FAKE_LSP_MODE", "die-after-init")
    log("invoked")

    server_status = False
    while True:
        msg = read_msg()
        if msg is None:
            return
        method = msg.get("method")
        if method == "initialized" and mode == "server-status-degraded" and server_status:
            for params in (
                {"health": "ok", "quiescent": False},
                {
                    "health": "warning",
                    "quiescent": True,
                    "message": "Failed to read Cargo metadata: Permission denied",
                },
            ):
                send({"jsonrpc": "2.0", "method": "experimental/serverStatus", "params": params})
            continue
        if method == "initialize":
            init_log = os.environ.get("FAKE_LSP_INIT_LOG")
            if init_log:
                with open(init_log, "a") as f:
                    opts = (msg.get("params") or {}).get("initializationOptions")
                    f.write(json.dumps(opts) + "\n")
            if mode == "rpc-error-init":
                send(
                    {
                        "jsonrpc": "2.0",
                        "id": msg["id"],
                        "error": {
                            "code": -32603,
                            "message": os.environ.get(
                                "FAKE_LSP_ERROR", "Request initialize failed with message: fake failure"
                            ),
                        },
                    }
                )
                continue
            if mode == "exit-before-reply":
                sys.stderr.write("fatal: boom (missing runtime)\n")
                sys.stderr.flush()
                sys.exit(1)
            if mode == "never-reply":
                continue
            if mode == "stderr-flood":
                line = ("x" * 1023 + "\n").encode()
                for _ in range(1024):
                    sys.stderr.buffer.write(line)
                sys.stderr.buffer.flush()
            caps = (msg.get("params") or {}).get("capabilities") or {}
            server_status = bool(
                (caps.get("experimental") or {}).get("serverStatusNotification")
            )
            send(
                {
                    "jsonrpc": "2.0",
                    "id": msg["id"],
                    "result": {"capabilities": {}},
                }
            )
            if mode == "die-after-init":
                # Crash right after init — simulates a dead server.
                return
            continue
        if method == "textDocument/definition":
            send({"jsonrpc": "2.0", "id": msg["id"], "result": []})
            continue
        # Any other request (no id? just a notification) -> stay alive, ignore.


if __name__ == "__main__":
    main()
