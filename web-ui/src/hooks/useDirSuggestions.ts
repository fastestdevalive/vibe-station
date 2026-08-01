import { useState, useRef, useEffect, useCallback } from "react";
import type { ApiInstance } from "@/api";

export function useDirSuggestions(api: ApiInstance) {
  const [suggestions, setSuggestions] = useState<{ name: string; path: string }[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reqIdRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchSuggestions = useCallback(async (path: string) => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.fsComplete(path);
      if (reqId !== reqIdRef.current) return; // stale — a newer request superseded it
      setSuggestions(res.entries);
      setTruncated(res.truncated);
      setLoading(false);
    } catch {
      if (reqId !== reqIdRef.current) return;
      setError("Failed to fetch directory suggestions");
      setSuggestions([]);
      setTruncated(false);
      setLoading(false);
    }
  }, [api]);

  const scheduleFetch = useCallback((path: string, debounceMs = 150) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void fetchSuggestions(path);
    }, debounceMs);
  }, [fetchSuggestions]);

  const reset = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSuggestions([]);
    setTruncated(false);
    setLoading(false);
    setError(null);
    reqIdRef.current++;
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return {
    suggestions,
    truncated,
    loading,
    error,
    fetchSuggestions,
    scheduleFetch,
    reset,
  };
}
