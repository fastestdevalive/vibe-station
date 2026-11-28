#!/usr/bin/env python3
"""Writes `readme.json`, the widget snapshot fixture used for the README's home-screen widget shots.

The mobile app's debug build renders any `assets/widget-fixtures/<name>.json` on the real widgets
(`WidgetFixtureReceiver`); copy this file there, build the debug APK, then
`adb shell am broadcast -a com.vst.mobile.debug.WIDGET_FIXTURE -n ai.vibestation.mobile/com.vst.mobile.WidgetFixtureReceiver --es name readme`.
All names are made up; the data matches the app's demo dataset. See docs/screenshots/README.md.

Usage: python scripts/mobile-widget-fixture.py OUT.json
"""
import json
import sys

M = 60_000  # ms per minute


def agent(sid, srv, title, kind, mode, ago_min, wt, proj, ctx, line, pinned):
    return {
        "serverId": srv, "sessionId": sid, "title": title, "statusKind": kind, "statusLabel": kind,
        "modeIcon": mode, "terminal": True, "pinned": pinned, "sinceMs": f"@now-{ago_min * M}",
        "deepLink": f"vst://{srv}/worktree/{wt}?session={sid}" if wt else f"vst://{srv}/session/{sid}",
        "worktreeId": wt, "projectId": proj, "lastLine": line, "contextLabel": ctx,
    }


AGENTS = [
    agent("a2", "s1", "migrate-db", "NeedsYou", "claude", 9, "wt5", "p1", "migrate-db", "Apply migration 0042 to the dev database?", True),
    agent("a5", "s1", "refactor-ui", "NeedsYou", "claude", 4, "wt3", "p1", "refactor-ui", "Plan is ready. Start phase 2?", True),
    agent("a7", "s2", "flaky-ci", "NeedsYou", "codex", 12, "wt6", "p2", "flaky-ci", "Retry the e2e job or quarantine the test?", False),
    agent("a1", "s1", "fix-login", "Working", "claude", 2, "wt1", "p1", "fix-login", "Editing auth middleware, 14 of 14 tests pass", True),
    agent("a6", "s2", "rate-limiter", "Working", "codex", 6, "wt4", "p2", "rate-limiter", "Running load test 3 of 5", True),
    agent("a8", "s1", "lint-sweep", "Working", "claude", 1, "wt3", "p1", "refactor-ui", "Fixing 12 lint warnings in web-ui", False),
    agent("a3", "s1", "docs-pass", "PrOpen", "codex", 14, "wt2", "p1", "docs-pass", "PR #41 is open.", True),
    agent("a4", "s1", "scratch-notes", "Idle", "claude", 120, None, "p1", "vibe-station", None, False),
]


def item(a, server_name):
    ago = int(a["sinceMs"].split("-")[1]) // M
    return {
        "serverId": a["serverId"], "serverName": server_name, "sessionId": a["sessionId"], "title": a["title"],
        "statusKind": a["statusKind"], "statusLabel": a["statusLabel"], "sinceText": f"{ago}m" if ago < 60 else f"{ago // 60}h",
        "deepLink": a["deepLink"], "modeIcon": a["modeIcon"], "terminal": True, "pinned": a["pinned"], "sinceMs": a["sinceMs"],
    }


def server(sid, name, limits):
    mine = [a for a in AGENTS if a["serverId"] == sid]
    return {
        "id": sid, "name": name, "status": "Connected", "freshAtMs": "@now", "agentCount": len(mine),
        "workingCount": sum(a["statusKind"] == "Working" for a in mine),
        "needsYouCount": sum(a["statusKind"] == "NeedsYou" for a in mine), "limits": limits,
    }


def window(wid, pct, resets_min, cadence):
    return {"windowId": wid, "usedPct": pct, "resetsAtMs": f"@now+{resets_min * M}", "asOfMs": "@now", "cadenceMinutes": cadence}


NAMES = {"s1": "home-box", "s2": "build-server"}
SNAPSHOT = {
    "schema": 2,
    "asOfMs": "@now",
    "paired": True,
    "demo": False,
    "servers": [
        server("s1", "home-box", [
            {"harness": "claude", "windows": [window("five_hour", 62, 129, 300), window("seven_day", 18, 8300, 10080)]},
            {"harness": "codex", "windows": [window("primary", 31, 220, 300), window("monthly", 44, 16000, 43200)]},
        ]),
        server("s2", "build-server", [
            {"harness": "codex", "windows": [window("primary", 12, 250, 300), window("monthly", 44, 16000, 43200)]},
        ]),
        # A paired machine that is switched off: the server widget shows it as unreachable.
        {"id": "s3", "name": "travel-laptop", "status": "Unreachable", "freshAtMs": "@now",
         "agentCount": 0, "workingCount": 0, "needsYouCount": 0, "limits": []},
    ],
    "items": [item(a, NAMES[a["serverId"]]) for a in AGENTS if a["pinned"] or a["statusKind"] == "NeedsYou"],
    "agents": AGENTS,
    "worktrees": [
        {"serverId": "s1", "id": "wt1", "name": "fix-login", "projectId": "p1", "projectName": "vibe-station", "statusKind": "Working",
         "agentCount": 1, "prState": None, "insertions": 128, "deletions": 41, "sinceMs": f"@now-{2 * M}", "deepLink": "vst://s1/worktree/wt1"},
        {"serverId": "s1", "id": "wt3", "name": "refactor-ui", "projectId": "p1", "projectName": "vibe-station", "statusKind": "NeedsYou",
         "agentCount": 2, "prState": None, "insertions": 342, "deletions": 187, "sinceMs": f"@now-{4 * M}", "deepLink": "vst://s1/worktree/wt3"},
        {"serverId": "s1", "id": "wt2", "name": "docs-pass", "projectId": "p1", "projectName": "vibe-station", "statusKind": "PrOpen",
         "agentCount": 1, "prState": "open", "insertions": 56, "deletions": 9, "sinceMs": f"@now-{14 * M}", "deepLink": "vst://s1/worktree/wt2"},
        {"serverId": "s1", "id": "wt5", "name": "migrate-db", "projectId": "p1", "projectName": "vibe-station", "statusKind": "NeedsYou",
         "agentCount": 1, "prState": None, "insertions": 77, "deletions": 12, "sinceMs": f"@now-{9 * M}", "deepLink": "vst://s1/worktree/wt5"},
        {"serverId": "s2", "id": "wt4", "name": "rate-limiter", "projectId": "p2", "projectName": "northstar-api", "statusKind": "Working",
         "agentCount": 1, "prState": None, "insertions": 210, "deletions": 18, "sinceMs": f"@now-{6 * M}", "deepLink": "vst://s2/worktree/wt4"},
        {"serverId": "s2", "id": "wt6", "name": "flaky-ci", "projectId": "p2", "projectName": "northstar-api", "statusKind": "NeedsYou",
         "agentCount": 1, "prState": None, "insertions": 8, "deletions": 3, "sinceMs": f"@now-{12 * M}", "deepLink": "vst://s2/worktree/wt6"},
    ],
    "projects": [
        {"serverId": "s1", "id": "p1", "name": "vibe-station", "deepLink": "vst://s1/project/p1"},
        {"serverId": "s2", "id": "p2", "name": "northstar-api", "deepLink": "vst://s2/project/p2"},
    ],
    "workspaces": [
        {"id": "ws1", "name": "Release prep", "members": [{"serverId": a["serverId"], "sessionId": a["sessionId"]} for a in AGENTS[:7]]},
    ],
}

if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    with open(sys.argv[1], "w") as f:
        json.dump(SNAPSHOT, f, indent=1)
        f.write("\n")
    print(f"wrote {sys.argv[1]}")
