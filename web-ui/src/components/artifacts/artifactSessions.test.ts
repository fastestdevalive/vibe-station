import { describe, expect, it } from "vitest";
import type { Session } from "@/api/types";
import { DELETED_AGENT_LABEL, otherWriterCount, otherWriterNames, writerOf } from "./artifactSessions";
import { makeRow } from "./testFixtures";

const main: Session = {
  id: "main",
  worktreeId: "wt1",
  projectId: "p1",
  modeId: null,
  type: "agent",
  name: "Main agent",
  isMain: true,
  state: "working",
  lifecycleState: "drafting",
  tmuxName: "main",
  createdAt: "2026-10-27T09:00:00.000Z",
};
const byId = new Map([[main.id, main]]);

describe("otherWriterNames / otherWriterCount", () => {
  it("a vanished first writer is the displayed one; the live writer is listed as the other", () => {
    const row = makeRow({ id: "x", writers: ["gone", "main"] });
    expect(writerOf(row, byId)).toBeNull();
    expect(otherWriterCount(row)).toBe(1);
    expect(otherWriterNames(row, byId, writerOf(row, byId))).toBe("Main agent");
  });

  it("two vanished writers: one displayed, the other shown as the deleted-agent label", () => {
    const row = makeRow({ id: "x", writers: ["gone1", "gone2"] });
    expect(otherWriterCount(row)).toBe(1);
    expect(otherWriterNames(row, byId, writerOf(row, byId))).toBe(DELETED_AGENT_LABEL);
  });

  it("filtered to the live writer, the vanished writer is the other one", () => {
    const row = makeRow({ id: "x", writers: ["gone", "main"] });
    const displayed = writerOf(row, byId, "main");
    expect(displayed?.id).toBe("main");
    expect(otherWriterCount(row)).toBe(1);
    expect(otherWriterNames(row, byId, displayed)).toBe(DELETED_AGENT_LABEL);
  });
});
