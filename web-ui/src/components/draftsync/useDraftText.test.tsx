import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { writeBuffer } from "./buffer";
import { engineFor, ensureDraftTextSync } from "./engine";
import { useDraftText } from "./useDraftText";

/** Let the engine's initial fetch (a resolved promise chain) settle. */
async function flushFetch(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const engines: Array<NonNullable<ReturnType<typeof engineFor>>> = [];

function startEngine(api: Parameters<typeof ensureDraftTextSync>[0]): void {
  ensureDraftTextSync(api);
  const engine = engineFor(api);
  if (engine) engines.push(engine);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
});

describe("useDraftText", () => {
  it("initialText_order_buffer_doc_legacy", async () => {
    // 1. A buffer based on the loaded doc's revision wins over the doc.
    const api = createMockApi();
    await api.putDraftText("s1", "server text", "other-client");
    writeBuffer("s1", "buffered edit", 1);
    startEngine(api);
    await flushFetch();
    const buffered = renderHook(() => useDraftText(api, "s1", { onRemote: () => {} }));
    expect(buffered.result.current.initialText).toBe("buffered edit");

    // 2. With no usable buffer, the loaded server doc is the first paint.
    await api.putDraftText("s2", "server two", "other-client");
    await flushFetch();
    const doc = renderHook(() => useDraftText(api, "s2", { onRemote: () => {} }));
    expect(doc.result.current.initialText).toBe("server two");

    // 3. Without an engine (no server state known), the legacy key is the first paint.
    const inertApi = createMockApi();
    localStorage.setItem("vst-chat-draft-s3", "legacy text");
    const legacy = renderHook(() => useDraftText(inertApi, "s3", { onRemote: () => {} }));
    expect(legacy.result.current.initialText).toBe("legacy text");
  });

  it("no_engine_is_inert", () => {
    const api = createMockApi();
    localStorage.setItem("vst-chat-draft-s1", "legacy text");
    const put = vi.spyOn(api, "putDraftText");
    const { result } = renderHook(() => useDraftText(api, "s1", { onRemote: () => {} }));

    expect(result.current.initialText).toBe("legacy text");
    act(() => result.current.save("typed"));
    act(() => result.current.flush());
    act(() => result.current.clear());
    act(() => result.current.dispose());

    expect(put).not.toHaveBeenCalled();
    expect(localStorage.getItem("vst-chat-draft-s1")).toBe("legacy text");
  });

  it("null_scope_inert", () => {
    const api = createMockApi();
    const put = vi.spyOn(api, "putDraftText");
    const { result } = renderHook(() => useDraftText(api, null, { onRemote: () => {} }));

    expect(result.current.initialText).toBe("");
    act(() => result.current.save("typed"));
    act(() => result.current.clear());

    expect(put).not.toHaveBeenCalled();
  });
});
