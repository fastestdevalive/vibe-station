#!/usr/bin/env python3
"""Fake LSP server for manager integration tests.

Driven by FAKE_LSP_MODE:
  - "die-after-init": responds to `initialize`, then exits immediately —
    simulating a server that aborts right after init (used for the dead-server
    detection / re-spawn test).
  - "stay-alive": responds to `initialize`, reads `initialized`, then loops
    reading requests, answering `textDocument/definition` with an empty array,
    and never sending `$/progress` (used for the settle / no-progress test).

Each invocation appends a line to the file at $FAKE_LSP_LOG (when set) so the
test can count how many distinct processes were spawned.
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

    while True:
        msg = read_msg()
        if msg is None:
            return
        method = msg.get("method")
        if method == "initialize":
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
