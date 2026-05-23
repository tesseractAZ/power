import { useEffect, useMemo, useState } from 'react';
import {
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { DeviceSnapshot, DpuProjection, Shp2Projection } from '../types';
import { fmtMins, fmtPct, fmtTemp, fmtW, fmtWh } from '../format';
import { sortDevices } from '../sort';

interface Point {
  ts: number;
  value: number;
}

interface DebugResp {
  sn: string;
  mqtt: Record<string, Record<string, unknown>>;
  lastMqttAt: number | null;
  mqttMsgCount: number;
}

/** EVSE monitoring source: nothing, an SHP2 paired circuit, or a host DPU. */
type EvseSource =
  | { kind: 'none' }
  | { kind: 'circuit'; primaryCh: number }
  | { kind: 'dpu'; sn: string };

const STORAGE_KEY = 'ecoflow-panel.evse.source';

function loadSource(): EvseSource {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v) {
      const parsed = JSON.parse(v);
      if (parsed && (parsed.kind === 'circuit' || parsed.kind === 'dpu' || parsed.kind === 'none')) {
        return parsed;
      }
    }
    // Migrate the old circuit-only key if present
    const old = window.localStorage.getItem('ecoflow-panel.evse.circuit');
    if (old) return { kind: 'circuit', primaryCh: Number(old) };
  } catch {
    /* ignore */
  }
  return { kind: 'none' };
}

export function EvsePanel({ devices }: { devices: Record<string, DeviceSnapshot> }) {
  const list = sortDevices(Object.values(devices));
  const evse = list.find((d) => d.productName === 'EVSE' || /car charger|evse/i.test(d.deviceName));
  const shp2 = list.find((d) => d.projection?.kind === 'shp2');
  const shp2Proj = shp2?.projection?.kind === 'shp2' ? (shp2.projection as Shp2Projection) : null;
  const dpus = list.filter((d) => d.productName?.toLowerCase().includes('delta pro ultra'));

  const [source, setSource] = useState<EvseSource>(() =>
    typeof window !== 'undefined' ? loadSource() : { kind: 'none' },
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(source));
  }, [source]);

  const [debug, setDebug] = useState<DebugResp | null>(null);
  const [history, setHistory] = useState<Point[]>([]);
  const [todayWh, setTodayWh] = useState<number | null>(null);

  // Resolve source → which device SN + metric to query, plus a display name
  const resolved = useMemo(() => {
    if (source.kind === 'circuit' && shp2 && shp2Proj) {
      const pc = shp2Proj.pairedCircuits.find((c) => c.primaryCh === source.primaryCh);
      if (!pc) return null;
      return {
        sn: shp2.sn,
        metric: pc.isSplitPhase ? `pair${pc.primaryCh}_w` : `ch${pc.primaryCh}_w`,
        name: pc.name,
        detail: pc.isSplitPhase ? `SHP2 ch${pc.primaryCh}+${pc.secondaryCh} · 240V` : `SHP2 ch${pc.primaryCh}`,
        liveW: pc.watts,
        dpu: null as (DeviceSnapshot & { projection: DpuProjection }) | null,
      };
    }
    if (source.kind === 'dpu') {
      const d = dpus.find((x) => x.sn === source.sn) as (DeviceSnapshot & { projection?: DpuProjection }) | undefined;
      if (!d) return null;
      return {
        sn: d.sn,
        metric: 'ac_out',
        name: d.deviceName,
        detail: `host DPU · AC output`,
        liveW: d.projection?.acOutWatts ?? null,
        dpu: d.projection ? (d as DeviceSnapshot & { projection: DpuProjection }) : null,
      };
    }
    return null;
  }, [source, shp2, shp2Proj, dpus]);

  // Poll EVSE debug data (direct MQTT inspector)
  useEffect(() => {
    if (!evse) return;
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/debug/raw?sn=${evse.sn}`);
        const j = (await r.json()) as DebugResp;
        if (!cancelled) setDebug(j);
      } catch {
        /* ignore */
      }
    };
    load();
    const t = window.setInterval(load, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [evse?.sn]);

  // Pull history (24h) for the resolved source
  useEffect(() => {
    if (!resolved) {
      setHistory([]);
      setTodayWh(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const r = await fetch(`/api/history?sn=${resolved.sn}&metric=${resolved.metric}&since=${since}&bucket=60`);
      const j = (await r.json()) as { points: Point[] };
      if (cancelled) return;
      setHistory(j.points);

      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const todayPts = j.points.filter((p) => p.ts >= dayStart.getTime());
      let wh = 0;
      const MAX_GAP = 10 * 60 * 1000;
      for (let i = 1; i < todayPts.length; i++) {
        const dt = todayPts[i].ts - todayPts[i - 1].ts;
        if (dt <= 0 || dt > MAX_GAP) continue;
        wh += ((todayPts[i].value + todayPts[i - 1].value) / 2) * (dt / 3_600_000);
      }
      setTodayWh(wh);
    };
    load();
    const t = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [resolved?.sn, resolved?.metric]);

  // Session detection: contiguous run of >1 kW with ≤15-min coalescing gaps
  const sessions = useMemo(() => {
    if (!history.length) return [] as Array<{ start: number; end: number; kwh: number; peakW: number }>;
    const THRESHOLD_W = 1000;
    const GAP_MS = 15 * 60 * 1000;
    const out: Array<{ start: number; end: number; kwh: number; peakW: number }> = [];
    let curStart: number | null = null;
    let curPeak = 0;
    let curWh = 0;
    let prev: Point | null = null;
    for (const p of history) {
      const active = p.value > THRESHOLD_W;
      if (active && curStart == null) {
        curStart = p.ts;
        curPeak = p.value;
        curWh = 0;
        prev = p;
        continue;
      }
      if (active && curStart != null && prev) {
        const dt = p.ts - prev.ts;
        if (dt <= GAP_MS) {
          curWh += ((p.value + prev.value) / 2) * (dt / 3_600_000);
          curPeak = Math.max(curPeak, p.value);
        } else {
          out.push({ start: curStart, end: prev.ts, kwh: curWh, peakW: curPeak });
          curStart = p.ts;
          curPeak = p.value;
          curWh = 0;
        }
        prev = p;
        continue;
      }
      if (!active && curStart != null && prev) {
        out.push({ start: curStart, end: prev.ts, kwh: curWh, peakW: curPeak });
        curStart = null;
        curPeak = 0;
        curWh = 0;
      }
      prev = p;
    }
    if (curStart != null && prev) {
      out.push({ start: curStart, end: prev.ts, kwh: curWh, peakW: curPeak });
    }
    return out.reverse();
  }, [history]);

  const liveW = resolved?.liveW ?? null;
  const currentlyCharging = (liveW ?? 0) > 1000;

  if (!evse) {
    return <div className="card">No EVSE / car charger found on the account.</div>;
  }

  return (
    <div className="space-y-4">
      {/* Top status */}
      <div className="card">
        <div className="card-title flex items-center justify-between">
          <span>Car charger</span>
          <span className="flex items-center gap-2 normal-case tracking-normal text-xs text-muted">
            <span className={`badge ${evse.online ? 'badge-ok' : 'badge-bad'}`}>{evse.online ? 'online' : 'offline'}</span>
            {currentlyCharging && <span className="badge badge-ok">charging now</span>}
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Tile
            label="Live draw"
            value={fmtW(liveW)}
            accent={currentlyCharging ? 'text-ok' : 'text-muted'}
            sub={resolved ? `via ${resolved.name}` : 'no source mapped'}
          />
          <Tile label="Today" value={fmtWh(todayWh)} accent="text-accent" sub={resolved ? '24h integration' : '—'} />
          <Tile
            label="Sessions today"
            value={String(sessions.filter((s) => isToday(s.start)).length)}
            sub={sessions.length ? `${sessions.length} in last 24h` : 'none detected'}
          />
          <Tile
            label="Direct telemetry"
            value={debug ? (debug.mqttMsgCount > 0 ? `${debug.mqttMsgCount} msgs` : 'silent') : '…'}
            sub={debug?.lastMqttAt ? `last ${new Date(debug.lastMqttAt).toLocaleTimeString()}` : 'EVSE app-only'}
          />
        </div>
        <div className="text-[11px] text-muted mt-3 leading-relaxed">
          The EcoFlow Open API doesn't expose EVSE telemetry directly. But the charger draws from a device we
          <em> can</em> read — pick that source below. A <span className="text-accent">host DPU</span> (the charger is wired
          straight to a Delta Pro Ultra) gives the most precise reading: that DPU's AC output is the charger draw.
          An <span className="text-accent">SHP2 circuit</span> works too if the charger is on the panel.
        </div>
      </div>

      {/* Source selector */}
      <div className="card">
        <div className="card-title">EVSE monitoring source</div>

        <div className="text-[10px] uppercase tracking-widest text-muted mt-1 mb-1">Host DPU (direct AC output — most accurate)</div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3">
          {dpus.map((d) => {
            const dp = d.projection?.kind === 'dpu' ? (d.projection as DpuProjection) : null;
            const selected = source.kind === 'dpu' && source.sn === d.sn;
            const acOut = dp?.acOutWatts ?? 0;
            return (
              <button
                type="button"
                key={d.sn}
                onClick={() => setSource({ kind: 'dpu', sn: d.sn })}
                className={`text-left bg-panel2 border rounded-lg p-2 hover:border-accent/60 transition-colors ${selected ? 'border-accent/60' : 'border-line'}`}
              >
                <div className="flex items-baseline justify-between">
                  <div className="text-sm font-medium truncate">{d.deviceName}</div>
                  <div className="text-[10px] text-muted">{d.online ? 'online' : 'offline'}</div>
                </div>
                <div className="flex items-baseline justify-between mt-1">
                  <div className={`text-sm tabular-nums ${acOut > 1 ? 'text-ok' : 'text-muted'}`}>{fmtW(acOut)}</div>
                  <div className="text-[10px] text-muted">AC out</div>
                </div>
              </button>
            );
          })}
        </div>

        {shp2Proj && (
          <>
            <div className="text-[10px] uppercase tracking-widest text-muted mb-1">SHP2 circuit (if charger is on the panel)</div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {shp2Proj.pairedCircuits.map((pc) => {
                const active = (pc.watts ?? 0) > 1;
                const selected = source.kind === 'circuit' && source.primaryCh === pc.primaryCh;
                return (
                  <button
                    type="button"
                    key={pc.primaryCh}
                    onClick={() => setSource({ kind: 'circuit', primaryCh: pc.primaryCh })}
                    className={`text-left bg-panel2 border rounded-lg p-2 hover:border-accent/60 transition-colors ${selected ? 'border-accent/60' : 'border-line'}`}
                  >
                    <div className="flex items-baseline justify-between">
                      <div className="text-sm font-medium truncate" title={pc.name}>{pc.name}</div>
                      <div className="text-[10px] text-muted">{pc.breakerAmps ?? '—'}A{pc.isSplitPhase ? ' · 240V' : ''}</div>
                    </div>
                    <div className="flex items-baseline justify-between mt-1">
                      <div className={`text-sm tabular-nums ${active ? 'text-ok' : 'text-muted'}`}>{fmtW(pc.watts)}</div>
                      <div className="text-[10px] text-muted">{pc.isSplitPhase ? `ch${pc.primaryCh}+${pc.secondaryCh}` : `ch${pc.primaryCh}`}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSource({ kind: 'none' })}
            className="badge badge-muted hover:bg-muted/20 transition-colors"
          >
            clear source
          </button>
          <span className="text-[11px] text-muted">
            Current: {resolved ? `${resolved.name} (${resolved.detail})` : 'none'}. Stored in your browser.
          </span>
        </div>
      </div>

      {/* Host-DPU bonus stats */}
      {resolved?.dpu && (
        <div className="card">
          <div className="card-title">Host DPU — {resolved.name}</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile label="DPU battery" value={fmtPct(resolved.dpu.projection.soc)} accent="text-accent" />
            <Tile label="AC output" value={fmtW(resolved.dpu.projection.acOutWatts)} accent={currentlyCharging ? 'text-ok' : 'text-muted'} />
            <Tile label="Out V / freq" value={`${resolved.dpu.projection.acOutVol?.toFixed(0) ?? '—'} V`} sub={`${resolved.dpu.projection.acOutFreq ?? '—'} Hz`} />
            <Tile label="Runtime left" value={fmtMins(resolved.dpu.projection.remainTimeMin)} sub="at current draw" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-3">
            {(['L11', 'L12', 'L14', 'L21', 'L22'] as const).map((leg) => (
              <div key={leg} className="bg-panel2/60 border border-line rounded-lg p-2 text-center">
                <div className="text-[10px] uppercase tracking-widest text-muted">{leg}</div>
                <div className="text-sm font-semibold tabular-nums">{fmtW(resolved.dpu!.projection.splitPhase[leg])}</div>
              </div>
            ))}
          </div>
          <div className="text-[11px] text-muted mt-2">
            Charger is wired directly to this DPU, so its AC output equals the charging draw. When the car charges you'll
            also see which battery packs supply it (Battery tab) and the SoC drain rate here.
          </div>
        </div>
      )}

      {/* 24h chart */}
      {resolved && history.length > 1 && (
        <div className="card">
          <div className="card-title flex items-center justify-between">
            <span>Charging power (24h)</span>
            <span className="text-xs text-muted normal-case tracking-normal">via {resolved.detail} · 1-min buckets</span>
          </div>
          <div style={{ width: '100%', height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={history} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="gradEvse" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0e7490" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#0e7490" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#c4cad3" strokeDasharray="3 3" />
                <XAxis
                  dataKey="ts"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tick={{ fill: '#586474', fontSize: 10 }}
                  tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                />
                <YAxis tick={{ fill: '#586474', fontSize: 10 }} width={56} unit=" W" />
                <Tooltip
                  contentStyle={{ background: '#ffffff', border: '1px solid #9aa3b0', borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: '#586474' }}
                  labelFormatter={(t) => new Date(t as number).toLocaleString()}
                  formatter={(v) => (typeof v === 'number' ? `${Math.round(v)} W` : v)}
                />
                <Area type="monotone" dataKey="value" stroke="#0e7490" fill="url(#gradEvse)" strokeWidth={1.5} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Sessions */}
      {resolved && (
        <div className="card">
          <div className="card-title">Detected sessions (last 24h, ≥ 1 kW)</div>
          {sessions.length === 0 ? (
            <div className="text-sm text-muted">No charging sessions detected in the last 24 hours.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] uppercase tracking-widest text-muted">
                    <th className="text-left py-1 pr-2">Started</th>
                    <th className="text-left py-1 pr-2">Ended</th>
                    <th className="text-right py-1 pr-2">Duration</th>
                    <th className="text-right py-1 pr-2">Energy</th>
                    <th className="text-right py-1">Peak</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="py-1 pr-2 tabular-nums">{new Date(s.start).toLocaleString()}</td>
                      <td className="py-1 pr-2 tabular-nums">{new Date(s.end).toLocaleString()}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">{fmtMins((s.end - s.start) / 60000)}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">{fmtWh(s.kwh)}</td>
                      <td className="py-1 text-right tabular-nums">{fmtW(s.peakW)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Direct EVSE telemetry inspector */}
      <div className="card">
        <div className="card-title flex items-center justify-between">
          <span>Direct EVSE telemetry</span>
          <span className="text-xs text-muted normal-case tracking-normal">
            {debug ? (debug.mqttMsgCount > 0 ? `${debug.mqttMsgCount} MQTT messages` : 'no MQTT messages') : 'loading…'}
          </span>
        </div>
        {!debug || debug.mqttMsgCount === 0 ? (
          <div className="text-sm text-muted">
            The EVSE itself is app-only — EcoFlow's developer API doesn't expose it. Monitoring it via the host DPU
            (above) is the accurate path. This inspector will still display any EVSE MQTT message if one ever arrives.
          </div>
        ) : (
          <div className="space-y-2">
            {Object.entries(debug.mqtt).map(([cmdId, params]) => (
              <div key={cmdId} className="bg-panel2/40 border border-line rounded-lg p-2">
                <div className="text-[10px] uppercase tracking-widest text-muted mb-1">cmdId {cmdId}</div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-0.5 text-xs">
                  {Object.entries(params).map(([k, v]) => (
                    <div key={k} className="kv">
                      <span className="kv-k">{k}</span>
                      <span className="kv-v truncate">{typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : String(v)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function isToday(ts: number): boolean {
  const d = new Date(ts);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function Tile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="bg-panel2/60 border border-line rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-widest text-muted">{label}</div>
      <div className={`text-2xl font-semibold mt-1 tabular-nums ${accent ?? ''}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted mt-1 truncate">{sub}</div>}
    </div>
  );
}
