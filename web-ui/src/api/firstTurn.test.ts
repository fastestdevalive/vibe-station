import { describe, it, expect, vi } from "vitest";
import type { ApiInstance } from "@/api";
import { sendJsonFirstTurn } from "./firstTurn";

describe("sendJsonFirstTurn mentions (1.T8)", () => {
  it("first turn with a mention sends wire text + mentions", async () => {
    const api = {
      uploadAttachments: vi.fn(),
      sendChat: vi.fn().mockResolvedValue({ turnId: "t1", queuePosition: 0 }),
    };

    await sendJsonFirstTurn(
      api as unknown as ApiInstance,
      "s1",
      'investigate {@file ["src/main.rs","main.rs"]}',
      [],
    );

    expect(api.sendChat).toHaveBeenCalledWith(
      "s1",
      "investigate @src/main.rs",
      [],
      undefined,
      [{ kind: "file", id: "src/main.rs", label: "main.rs" }],
    );
  });

  it("first turn without mentions calls sendChat with 3 args", async () => {
    const api = {
      uploadAttachments: vi.fn(),
      sendChat: vi.fn().mockResolvedValue({ turnId: "t1", queuePosition: 0 }),
    };

    await sendJsonFirstTurn(
      api as unknown as ApiInstance,
      "s1",
      "investigate issue",
      [],
    );

    expect(api.sendChat).toHaveBeenCalledWith("s1", "investigate issue", []);
    expect(api.sendChat.mock.calls[0]?.length).toBe(3);
  });
});
