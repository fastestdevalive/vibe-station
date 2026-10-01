import { createClientApi } from "./client";
import { createMockApi } from "./mock";

/** Default real API unless `VITE_USE_MOCK=true`; the website demos inject a
 *  seeded mock instance before import via `globalThis.__VST_DEMO_API__`. */
const injected = (globalThis as { __VST_DEMO_API__?: ApiInstance }).__VST_DEMO_API__;
// Reject DOM nodes: an element with that id would also appear as a global property. (A demo may inject a
// lazy proxy whose methods are only defined once a demo mounts, so do not require specific methods here.)
const injectedApi = injected && !(typeof Node !== "undefined" && (injected as unknown) instanceof Node) ? injected : undefined;
export const api =
  injectedApi ?? (import.meta.env.VITE_USE_MOCK === "true" ? createMockApi() : createClientApi());

export type ApiInstance = ReturnType<typeof createMockApi> | ReturnType<typeof createClientApi>;

export { ApiError } from "./errors";
export * from "./types";
export { createMockApi } from "./mock";
export { createClientApi } from "./client";
export type { ConnectionState, AuthEvent } from "./client";
