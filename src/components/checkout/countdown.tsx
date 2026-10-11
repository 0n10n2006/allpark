"use client";

import { useEffect, useState } from "react";

/**
 * Whole seconds until `target`, ticking every second; null before mount (no clock reads
 * during render). `skewMs` = server clock minus client clock, so expiry follows server time.
 */
export function useSecondsLeft(target: string | null, skewMs = 0): number | null {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!target) return;
    const end = new Date(target).getTime();
    const tick = () => setLeft(Math.max(0, Math.ceil((end - (Date.now() + skewMs)) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [target, skewMs]);
  return target ? left : null;
}

export function formatMmSs(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds % 60).padStart(2, "0")}`;
}
