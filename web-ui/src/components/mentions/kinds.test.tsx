import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createEditor } from "lexical";
import type { Mention } from "@/api/types";
import { MENTION_KINDS, mentionKindDef, isKnownMentionKind } from "./kinds";
import { MentionChipView } from "./MentionChipView";
import { parseMentionQuery } from "./mentionQuery";
import { $findActiveAtToken } from "./mentionOps";
import { MentionChipNode } from "@/lexical/MentionChipNode";
import { mentionPlainText, safeMentionLabel, fromWire, parseDraftSegments } from "@/lib/mentions";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";

const stale = { kind: "artifact", id: "a1", label: "Plan" } as unknown as Mention;

describe("unknown mention kinds", () => {
  it("mentionKindDef falls back instead of throwing", () => {
    expect(() => mentionKindDef("artifact")).not.toThrow();
    expect(mentionKindDef("artifact").plainPrefix).toBe("@");
    expect(isKnownMentionKind("artifact")).toBe(false);
    expect(isKnownMentionKind("file")).toBe(true);
  });

  it("MentionChipView renders a generic chip", () => {
    render(<MentionChipView mention={stale} />);
    expect(screen.getByText("Plan")).toBeTruthy();
  });

  it("mentionPlainText defaults to @label", () => {
    expect(mentionPlainText(stale)).toBe("@Plan");
    expect(mentionPlainText({ ...stale, label: "My Plan" })).toBe('@"My Plan"');
  });

  it("importJSON keeps unknown kinds and tolerates bad fields", () => {
    const editor = createEditor({ nodes: [MentionChipNode], onError: (e) => { throw e; } });
    let mention: Mention | null = null;
    editor.update(
      () => {
        const node = MentionChipNode.importJSON({
          type: "mention-chip", version: 1, kind: "artifact", id: 5, label: undefined,
        } as never);
        mention = node.getMention();
      },
      { discrete: true },
    );
    expect(mention).toEqual({ kind: "artifact", id: "", label: "" });
  });

  it("fromWire does not throw for an unknown kind", () => {
    expect(() => fromWire("see @Plan now", [stale])).not.toThrow();
  });

  it("draft tokens with unknown kinds stay literal text", () => {
    const segs = parseDraftSegments('{@artifact ["a","b"]}');
    expect(segs.every((s) => s.type !== "mention")).toBe(true);
  });
});

describe("kind registry is the single source", () => {
  it("scope names come from MENTION_KINDS", () => {
    for (const k of MENTION_KINDS) {
      expect(parseMentionQuery(`${k.section}:x`).scope).toBe(k.kind);
      expect(parseMentionQuery(`${k.singular.toUpperCase()}:x`).scope).toBe(k.kind);
    }
    expect(parseMentionQuery("widgets:x").scope).toBeNull();
  });
});

describe("safeMentionLabel", () => {
  it("never returns empty", () => {
    expect(safeMentionLabel({ kind: "agent", id: "s1", label: "   " })).toBe("s1");
    expect(safeMentionLabel({ kind: "file", id: "src/a.ts", label: "\u0001\u0002" })).toBe("a.ts");
    expect(safeMentionLabel({ kind: "project", id: "p", label: "Name" })).toBe("Name");
  });
});

describe("@ boundary rule shared with lib/mentions", () => {
  function activeTokenFor(text: string) {
    const editor = createEditor({ nodes: [MentionChipNode], onError: (e) => { throw e; } });
    editor.setRootElement(document.createElement("div"));
    let result: ReturnType<typeof $findActiveAtToken> = null;
    editor.update(
      () => {
        const p = $createParagraphNode();
        const t = $createTextNode(text);
        p.append(t);
        $getRoot().clear().append(p);
        t.select(text.length, text.length);
        result = $findActiveAtToken();
      },
      { discrete: true },
    );
    return result;
  }

  it("opens after ( and quotes like fromWire does, not mid-word", () => {
    expect(activeTokenFor("(@foo")).not.toBeNull();
    expect(activeTokenFor('"@foo')).not.toBeNull();
    expect(activeTokenFor("see @foo")).not.toBeNull();
    expect(activeTokenFor("a@foo")).toBeNull();
  });
});
