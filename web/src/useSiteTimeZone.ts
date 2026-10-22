import { useEffect, useState } from 'react';
import { apiUrl } from './api';

/**
 * v1.191.0 (lane A, T16/CA25) — the site zone the server reports on GET /api/site, fetched once
 * per page load and shared by every card that needs it (null until it arrives, or if it cannot be
 * read — a card then shows no site-local time rather than the browser's).
 */
let pending: Promise<string | null> | null = null;

export function fetchSiteTimeZone(): Promise<string | null> {
  pending ??= fetch(apiUrl('api/site'))
    .then((r) => (r.ok ? r.json() : null))
    .then((j: unknown) => {
      const z = (j as { siteTimeZone?: unknown } | null)?.siteTimeZone;
      if (typeof z === 'string' && z.length > 0) return z;
      pending = null; // retry on the next mount
      return null;
    })
    .catch(() => { pending = null; return null; });
  return pending;
}

export function useSiteTimeZone(): string | null {
  const [zone, setZone] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void fetchSiteTimeZone().then((z) => { if (live) setZone(z); });
    return () => { live = false; };
  }, []);
  return zone;
}
