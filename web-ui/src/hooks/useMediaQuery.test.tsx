import { renderHook } from '@testing-library/react';
import { useMediaQuery } from './useMediaQuery';
import { DemoEnvProvider } from '../context/DemoEnv';
import { describe, it, expect } from 'vitest';
import { useState } from 'react';

describe('useMediaQuery', () => {
  it('falls back to window.matchMedia', () => {
    const { result } = renderHook(() => useMediaQuery('(prefers-color-scheme: dark)'));
    expect(typeof result.current).toBe('boolean');
  });

  it('uses env viewport width when provided', () => {
    const customEnv = { demo: true, viewport: { w: 500, h: 1000 }, scale: 1, portalRoot: null, eventRoot: null };
    const wrapper = ({ children }: any) => <DemoEnvProvider value={customEnv}>{children}</DemoEnvProvider>;
    
    const { result: r1 } = renderHook(() => useMediaQuery('(max-width: 600px)'), { wrapper });
    expect(r1.current).toBe(true);
    
    const { result: r2 } = renderHook(() => useMediaQuery('(max-width: 400px)'), { wrapper });
    expect(r2.current).toBe(false);
    
    const { result: r3 } = renderHook(() => useMediaQuery('(min-width: 400px)'), { wrapper });
    expect(r3.current).toBe(true);
  });
});
