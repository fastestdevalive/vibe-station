/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_USE_MOCK: string | undefined;
  readonly VITE_DAEMON_URL: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
