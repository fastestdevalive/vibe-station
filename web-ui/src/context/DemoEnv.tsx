import { createContext, useContext, ReactNode } from 'react';

export interface DemoEnv {
  demo: boolean;
  viewport: { w: number; h: number } | null;
  scale: number;
  portalRoot: HTMLElement | null;
  eventRoot: HTMLElement | null;
}

export const DEFAULT_DEMO_ENV: DemoEnv = {
  demo: false,
  viewport: null,
  scale: 1,
  portalRoot: null,
  eventRoot: null,
};

const DemoEnvContext = createContext<DemoEnv>(DEFAULT_DEMO_ENV);

export function DemoEnvProvider({ value, children }: { value: DemoEnv; children: ReactNode }) {
  return <DemoEnvContext.Provider value={value}>{children}</DemoEnvContext.Provider>;
}

export function useDemoEnv(): DemoEnv {
  return useContext(DemoEnvContext);
}

export function usePortalRoot(): HTMLElement {
  const env = useDemoEnv();
  return env.portalRoot ?? document.body;
}

export function useViewportWidth(): number {
  const env = useDemoEnv();
  return env.viewport?.w ?? window.innerWidth;
}

export function useEventTargets() {
  const env = useDemoEnv();
  return {
    doc: (env.eventRoot ?? document) as Pick<Document, 'addEventListener' | 'removeEventListener'>,
    win: (env.eventRoot ?? window) as Pick<Window, 'addEventListener' | 'removeEventListener'>,
  };
}
