import { renderHook } from '@testing-library/react';
import { useDemoEnv, usePortalRoot, useViewportWidth, useEventTargets, DemoEnvProvider } from './DemoEnv';
import { describe, it, expect } from 'vitest';

describe('DemoEnv Context', () => {
  it('provides default values', () => {
    const { result } = renderHook(() => useDemoEnv());
    expect(result.current.demo).toBe(false);
    expect(result.current.viewport).toBeNull();
    expect(result.current.scale).toBe(1);
    expect(result.current.portalRoot).toBeNull();
    expect(result.current.eventRoot).toBeNull();
  });

  it('usePortalRoot defaults to document.body', () => {
    const { result } = renderHook(() => usePortalRoot());
    expect(result.current).toBe(document.body);
  });

  it('useViewportWidth defaults to window.innerWidth', () => {
    const { result } = renderHook(() => useViewportWidth());
    expect(result.current).toBe(window.innerWidth);
  });

  it('useEventTargets defaults to document and window', () => {
    const { result } = renderHook(() => useEventTargets());
    expect(result.current.doc).toBe(document);
    expect(result.current.win).toBe(window);
  });
  
  it('respects provided values', () => {
     const dummyElement = document.createElement('div');
     const customEnv = { demo: true, viewport: { w: 100, h: 200 }, scale: 2, portalRoot: dummyElement, eventRoot: dummyElement };
     const wrapper = ({ children }: any) => <DemoEnvProvider value={customEnv}>{children}</DemoEnvProvider>;
     
     const { result: rootResult } = renderHook(() => usePortalRoot(), { wrapper });
     expect(rootResult.current).toBe(dummyElement);
     
     const { result: widthResult } = renderHook(() => useViewportWidth(), { wrapper });
     expect(widthResult.current).toBe(100);
     
     const { result: targetResult } = renderHook(() => useEventTargets(), { wrapper });
     expect(targetResult.current.doc).toBe(dummyElement);
     expect(targetResult.current.win).toBe(dummyElement);
  });
});
