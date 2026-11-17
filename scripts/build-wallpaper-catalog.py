#!/usr/bin/env python3
"""Regenerate `rust/vst-wallpapers/assets/catalog.json` (the bundled CC0 catalog).

Usage:
  python3 -I scripts/build-wallpaper-catalog.py \
      --mobile <vibe-station-mobile wallpapers.json> [--feed <unlauncher metadata.json>] \
      --out rust/vst-wallpapers/assets/catalog.json

Ids, names, authors, licences and source pages come from mobile's wallpapers.json
(31 CC0 entries, wp-001..wp-031, stable ids). The optional unlauncher feed is
joined by `sourcePage`; a matched entry takes the feed's url, thumbnailUrl, shas,
size, category and mode. An unmatched entry (or a run without --feed) keeps
mobile's url as both url and thumbnailUrl, category "places", mode "any" and no
shas. `author: "unknown"` becomes null; `accessLevel` is ignored.

Stdlib only; deterministic output (ids sorted, 2-space JSON, trailing newline).
Exits non-zero unless exactly 31 entries were written.
"""

import argparse
import json
import os
import sys

EXPECTED_COUNT = 31
CATALOG_VERSION = 1
MODES = ("dark", "light", "any")
DEFAULT_CATEGORY = "places"
DEFAULT_MODE = "any"


def load_wallpapers(path, label):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError as exc:
        sys.exit(f"cannot read {label} {path}: {exc}")
    except json.JSONDecodeError as exc:
        sys.exit(f"{label} {path} is not valid JSON: {exc}")
    wallpapers = data.get("wallpapers") if isinstance(data, dict) else None
    if not isinstance(wallpapers, list):
        sys.exit(f"{label} {path} has no wallpapers array")
    return wallpapers


def feed_index(feed):
    by_page = {}
    for entry in feed:
        page = entry.get("sourcePage")
        if isinstance(page, str) and page:
            by_page[page] = entry
    return by_page


def mode_or_default(value):
    return value if value in MODES else DEFAULT_MODE


def build_entry(mobile, feed_entry):
    source_page = mobile.get("sourcePage")
    author = mobile.get("author") or ""
    if author.strip().lower() == "unknown":
        author = None

    entry = {
        "id": mobile["id"],
        "name": mobile.get("title") or "",
        "category": DEFAULT_CATEGORY,
        "mode": DEFAULT_MODE,
        "url": mobile["url"],
        "thumbnailUrl": mobile["url"],
        "fullSizeSha": None,
        "thumbnailSha": None,
        "width": mobile.get("width", 0),
        "height": mobile.get("height", 0),
        "license": mobile.get("license"),
        "author": author,
        "sourcePage": source_page,
    }
    if feed_entry is not None:
        entry.update(
            {
                "category": feed_entry.get("category") or DEFAULT_CATEGORY,
                "mode": mode_or_default(feed_entry.get("mode")),
                "url": feed_entry.get("url") or entry["url"],
                "thumbnailUrl": feed_entry.get("thumbnailUrl") or entry["url"],
                "fullSizeSha": feed_entry.get("fullSizeSha"),
                "thumbnailSha": feed_entry.get("thumbnailSha"),
                "width": feed_entry.get("width", entry["width"]),
                "height": feed_entry.get("height", entry["height"]),
            }
        )
    return entry


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--mobile", required=True, help="mobile wallpapers.json")
    parser.add_argument("--feed", help="optional unlauncher wallpapers-metadata.json")
    parser.add_argument(
        "--out",
        default=os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "rust",
            "vst-wallpapers",
            "assets",
            "catalog.json",
        ),
        help="output catalog.json",
    )
    args = parser.parse_args()

    mobile = load_wallpapers(args.mobile, "mobile catalog")
    by_page = feed_index(load_wallpapers(args.feed, "feed")) if args.feed else {}

    wallpapers = []
    matched = 0
    for item in mobile:
        feed_entry = by_page.get(item.get("sourcePage"))
        if feed_entry is not None:
            matched += 1
        wallpapers.append(build_entry(item, feed_entry))

    wallpapers.sort(key=lambda entry: entry["id"])
    ids = [entry["id"] for entry in wallpapers]
    if len(set(ids)) != len(ids):
        sys.exit(f"duplicate wallpaper ids: {ids}")
    if len(wallpapers) != EXPECTED_COUNT:
        sys.exit(f"expected {EXPECTED_COUNT} wallpapers, built {len(wallpapers)}")

    payload = {"version": CATALOG_VERSION, "wallpapers": wallpapers}
    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    print(f"wrote {len(wallpapers)} wallpapers ({matched} via feed) to {args.out}")


if __name__ == "__main__":
    main()
