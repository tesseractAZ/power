import { useEffect, useState } from 'react';
import { apiUrl } from './api';
import type { Site } from './types';

/**
 * v1.191.0 (lane C) — GET /api/site, fetched once for the whole page and shared by every card that
 * reads a site fact (PV strings, the bench-spare flag, the solar assumptions). With useSiteTimeZone.ts
 * (the zone alone, fetched once per page load) it is how the cards learn the site (plan 2.7): they do
 * not guess from the browser. Until the first answer, and after a
 * failed one, `null` — every helper in siteFacts.ts then answers as the cards did before v1.191.0.
 * The facts change only with the options or the panel roster, so a five-minute refresh is enough.
 */
const REFRESH_MS = 5 * 60_000;

let current: Site | null = null;
let lastAttemptAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<(s: Site | null) => void>();

function refresh(): Promise<void> {
  if (inflight) return inflight;
  lastAttemptAt = Date.now();
  inflight = (async () => {
    try {
      const r = await fetch(apiUrl('api/site'));
      if (!r.ok) return;
      const j = (await r.json()) as Site;
      if (j && typeof j === 'object' && j.pvStrings) {
        current = j;
        for (const l of listeners) l(current);
      }
    } catch {
      /* keep the last good answer */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function useSite(): Site | null {
  const [site, setSite] = useState<Site | null>(current);
  useEffect(() => {
    listeners.add(setSite);
    if (current) setSite(current);
    if (!current || Date.now() - lastAttemptAt >= REFRESH_MS) void refresh();
    const t = window.setInterval(() => {
      if (Date.now() - lastAttemptAt >= REFRESH_MS) void refresh();
    }, REFRESH_MS);
    return () => {
      listeners.delete(setSite);
      window.clearInterval(t);
    };
  }, []);
  return site;
}
