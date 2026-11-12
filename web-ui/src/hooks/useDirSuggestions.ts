import { useState, useRef, useEffect, useCallback } from "react";
import type { ApiInstance } from "@/api";

export function useDirSuggestions(api: ApiInstance) {
  const [suggestions, setSuggestions] = useState<{ name: string; path: string }[]>([]);
  // The path whose response is in `suggestions` (null: none / failed / reset).
  const [listedFor, setListedFor] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True once the latest request has answered or failed; false while one is in
  // flight and after reset(). Lets a caller tell "no matches" from "not asked yet".
  const [settled, setSettled] = useState(false);

  const reqIdRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchSuggestions = useCallback(async (path: string) => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setSettled(false);
    setError(null);
    try {
      const res = await api.fsComplete(path);
      if (reqId !== reqIdRef.current) return; // stale — a newer request superseded it
      setSuggestions(res.entries);
      setListedFor(path);
      setTruncated(res.truncated);
      setLoading(false);
      setSettled(true);
    } catch {
      if (reqId !== reqIdRef.current) return;
      setError("Failed to fetch directory suggestions");
      setSuggestions([]);
      setListedFor(null);
      setTruncated(false);
      setLoading(false);
      setSettled(true);
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
    setListedFor(null);
    setTruncated(false);
    setLoading(false);
    setError(null);
    setSettled(false);
    reqIdRef.current++;
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return {
    suggestions,
    listedFor,
    truncated,
    loading,
    error,
    settled,
    fetchSuggestions,
    scheduleFetch,
    reset,
  };
}
