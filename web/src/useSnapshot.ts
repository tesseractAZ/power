import { useEffect, useRef, useState } from 'react';
import type { FleetSnapshot } from './types';
import { wsUrl } from './api';

import type { ConnState } from './freshness';
import { nextClockOffset } from './freshness';
export type { ConnState };

/**
 * `clockOffsetMs` (v1.176.0) = browser clock − server clock, measured on each frame from
 * the server's send-time stamp. Data ages are computed on the server's clock (browser now −
 * offset) because every telemetry timestamp is server-stamped; comparing them with the
 * browser's own clock made the header and LIVE pill wrong by the skew between the two.
 */
export function useSnapshot(): { snapshot: FleetSnapshot | null; conn: ConnState; clockOffsetMs: number } {
  const [snapshot, setSnapshot] = useState<FleetSnapshot | null>(null);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const retryRef = useRef(0);

  useEffect(() => {
    let stopped = false;
    let ws: WebSocket | null = null;
    /** Least browser-minus-server sample on the current socket (see onmessage). */
    let minOffset: number | null = null;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (stopped) return;
      setConn('connecting');
      // v0.9.5 — wsUrl() builds the URL relative to the SPA's current path,
      // so it works both on direct LAN (:8787/ws) and under HA Ingress
      // (/api/hassio_ingress/<token>/ws).
      ws = new WebSocket(wsUrl());
      ws.onopen = () => {
        setConn('open');
        retryRef.current = 0;
        minOffset = null;
      };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === 'snapshot') {
            setSnapshot(m.data);
            if (typeof m.serverNowMs === 'number' && Number.isFinite(m.serverNowMs)) {
              // The minimum sample since the socket opened (nextClockOffset); reset on reconnect.
              const next = nextClockOffset(minOffset, Date.now() - m.serverNowMs);
              if (next !== minOffset) {
                minOffset = next;
                setClockOffsetMs(next);
              }
            }
          }
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        setConn('closed');
        if (stopped) return;
        const delay = Math.min(15000, 500 * 2 ** retryRef.current++);
        reconnectTimer = window.setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  return { snapshot, conn, clockOffsetMs };
}
