"use client";

import { useCallback, useEffect, useState } from "react";
import type { VaultState } from "@/lib/vault";

// The HUD's two sources of motion: the vault snapshot and the wall clock.
//
// Polling rather than pushing is a deliberate simplification — the vault is
// files, and anything (the runner, the user's editor, a script) can change
// them. A five-second poll means every writer is equal and none of them needs
// to know the HUD exists.

export function useVaultState(intervalMs = 5000) {
  const [state, setState] = useState<VaultState | null>(null);
  const [error, setError] = useState(false);

  const pull = useCallback(async () => {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setState(await res.json());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    pull();
    const id = setInterval(pull, intervalMs);
    return () => clearInterval(id);
  }, [pull, intervalMs]);

  return { state, error, refresh: pull };
}

export function useClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}
