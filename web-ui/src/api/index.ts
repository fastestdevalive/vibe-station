import { createClientApi } from "./client";
import { createMockApi } from "./mock";

/** Default real API unless `VITE_USE_MOCK=true`. */
export const api =
  import.meta.env.VITE_USE_MOCK === "true" ? createMockApi() : createClientApi();

export type ApiInstance = ReturnType<typeof createMockApi> | ReturnType<typeof createClientApi>;

export { ApiError } from "./errors";
export * from "./types";
export { createMockApi } from "./mock";
export { createClientApi } from "./client";
