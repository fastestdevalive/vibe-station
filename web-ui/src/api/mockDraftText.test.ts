import { describe, expect, it } from "vitest";
import { createMockDraftText } from "./mockDraftText";
import type { WSEvent } from "./types";

function setup() {
  const events: WSEvent[] = [];
  const client = createMockDraftText((ev) => events.push(ev));
  return { events, client };
}

describe("createMockDraftText", () => {
  it("revision_bumps", async () => {
    const { client, events } = setup();
    const first = await client.putDraftText("s1", "a", "c1");
    expect(first).toMatchObject({ scope: "s1", text: "a", revision: 1, clientId: "c1" });
    const second = await client.putDraftText("s1", "ab", "c2");
    expect(second.revision).toBe(2);
    expect(second.clientId).toBe("c2");
    expect(events.map((e) => e.type)).toEqual(["draft-text:changed", "draft-text:changed"]);
    expect(events[1]).toMatchObject({ scope: "s1", text: "ab", revision: 2, clientId: "c2" });
  });

  it("unchanged_emits_nothing", async () => {
    const { client, events } = setup();
    const first = await client.putDraftText("s1", "same", "c1");
    const again = await client.putDraftText("s1", "same", "c2");
    expect(again).toEqual(first);
    expect(events).toHaveLength(1);
  });

  it("an absent scope reads as the revision-0 empty doc; tombstones are listed", async () => {
    const { client } = setup();
    expect(await client.getDraftText("s1")).toEqual({
      scope: "s1",
      text: "",
      revision: 0,
      updatedAt: null,
      clientId: null,
    });
    await client.putDraftText("s1", "typed", "c1");
    const cleared = await client.putDraftText("s1", "", "c1");
    expect(cleared).toMatchObject({ text: "", revision: 2 });
    expect((await client.listDraftTexts()).map((d) => d.scope)).toEqual(["s1"]);
  });

  it("rejects over-cap text, a bad scope and a bad client id", async () => {
    const { client, events } = setup();
    await expect(client.putDraftText("s1", "é".repeat(32769), "c1")).rejects.toMatchObject({
      status: 413,
      code: "draft_too_large",
    });
    await expect(client.putDraftText("bad scope", "x", "c1")).rejects.toMatchObject({ status: 400, code: "bad_scope" });
    await expect(client.putDraftText("s1", "x", "")).rejects.toMatchObject({ status: 400, code: "bad_client_id" });
    expect(events).toHaveLength(0);
  });
});
