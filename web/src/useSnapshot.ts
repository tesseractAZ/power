import { useEffect, useRef, useState } from 'react';
import type { FleetSnapshot } from './types';
import { wsUrl } from './api';

import type { ConnState } from './freshness';
export type { ConnState };

export function useSnapshot(): { snapshot: FleetSnapshot | null; conn: ConnState } {
  const [snapshot, setSnapshot] = useState<FleetSnapshot | null>(null);
  const [conn, setConn] = useState<ConnState>('connecting');
  const retryRef = useRef(0);

  useEffect(() => {
    let stopped = false;
    let ws: WebSocket | null = null;
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
      };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === 'snapshot') setSnapshot(m.data);
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

  return { snapshot, conn };
}
