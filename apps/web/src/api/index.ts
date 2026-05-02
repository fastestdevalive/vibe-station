import { createClientApi } from "./client";
import { createMockApi } from "./mock";

/** Default mock unless `VITE_USE_MOCK=false`. */
export const api =
  import.meta.env.VITE_USE_MOCK === "false" ? createClientApi() : createMockApi();

export type ApiInstance = ReturnType<typeof createMockApi> | ReturnType<typeof createClientApi>;

export { ApiError } from "./errors";
export * from "./types";
export { createMockApi } from "./mock";
export { createClientApi } from "./client";
