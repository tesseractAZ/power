/**
 * v0.9.40 — The Living World.
 *
 * The visual centerpiece of the Opus skin. A breathing emerald sphere
 * representing the household energy ecosystem. Three orbiting particle
 * streams convey the three flows:
 *
 *   SOLAR (gold)    inbound → sphere
 *   STORAGE (violet) bidirectional ↔ sphere
 *   LOADS (pink)   outbound from sphere
 *
 * Particle counts scale with actual watts so a sunny noon shows a
 * gold stream of many particles, while a cloudy morning shows a thin
 * trickle. The sphere itself "breathes" with a slow 8-sec pulse —
 * not data-driven, just an ambient sign-of-life.
 *
 * Inspired by:
 *  - Genesis Device sequence (ST II)
 *  - macOS Big Sur wallpaper depth
 *  - data-flow visualizations in Vercel Analytics
 *
 * Built entirely in SVG + CSS animations — no JS animation loop, no
 * canvas, no Web Audio. Plays nicely with React reconciliation and the
 * existing low-frequency snapshot-update cadence.
 */

import { useMemo } from 'react';
import { totalPvWatts, totalLoadWatts, fleetSoc, fmtWatts, fmtPct } from '../utils';
import type { FleetSnapshot } from '../../types';

interface LivingWorldProps {
  snapshot: FleetSnapshot | null;
}

export function LivingWorld({ snapshot }: LivingWorldProps) {
  const pv = totalPvWatts(snapshot);
  const load = totalLoadWatts(snapshot);
  const soc = fleetSoc(snapshot);

  // Map watts to particle count (1 particle per ~600W, capped at 16).
  const pvCount = clamp(Math.round(pv / 600), pv > 0 ? 1 : 0, 16);
  const loadCount = clamp(Math.round(load / 500), load > 0 ? 1 : 0, 12);
  // Storage particles reflect battery activity (charging vs discharging).
  // Net flow = pv - load. If positive, storage is filling; if negative, drawing.
  const storageNet = pv - load;
  const storageCount = clamp(Math.round(Math.abs(storageNet) / 800), 1, 10);
  const storageDir = storageNet >= 0 ? 'in' : 'out';

  // SoC drives a thin emerald ring around the sphere — a "skin" that
  // grows from 0° (empty) to 360° (full). Always visible to anchor the
  // user's eye on the most important single number.
  const socAngle = ((soc ?? 0) / 100) * 360;
  const socColor = soc != null && soc < 25 ? 'var(--color-bad)' : 'var(--opus-life-1)';

  // Pre-build particle definitions so React keys are stable across renders.
  const pvParticles = useMemo(() => buildParticles(pvCount, 'pv'), [pvCount]);
  const loadParticles = useMemo(() => buildParticles(loadCount, 'load'), [loadCount]);
  const storageParticles = useMemo(() => buildParticles(storageCount, 'storage'), [storageCount]);

  const pvFmt = fmtWatts(pv);
  const loadFmt = fmtWatts(load);

  return (
    <div className="opus-glass opus-glass-hover relative overflow-hidden p-8" style={{ minHeight: 520 }}>
      {/* Eyebrow + section heading */}
      <div className="flex items-center justify-between mb-1">
        <div className="opus-eyebrow">GENESIS · LIVING WORLD</div>
        <div className="opus-label">{new Date().toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>
      </div>
      <div className="opus-label" style={{ color: 'rgb(var(--color-ink))', fontSize: 18, letterSpacing: '0.02em', textTransform: 'none', fontWeight: 500, marginBottom: 24 }}>
        Your home is {storageDir === 'in' && storageNet > 200 ? 'gathering energy.' : storageDir === 'out' && storageNet < -200 ? 'spending energy.' : 'in balance.'}
      </div>

      {/* The sphere + orbits */}
      <div className="relative flex justify-center items-center" style={{ height: 360 }}>
        <Sphere socAngle={socAngle} socColor={socColor} soc={soc} />

        {/* Three orbit rings — concentric, with particles flowing along each.
            Each ring is centered absolutely; particles use opus-orbit-particle
            with a per-particle --r (radius) and --dur (orbit period). */}
        <Orbit radius={120} color="var(--opus-solar)"  particles={pvParticles}      reverse={false} />
        <Orbit radius={160} color="var(--opus-storage)" particles={storageParticles} reverse={storageDir === 'out'} />
        <Orbit radius={200} color="var(--opus-load)"   particles={loadParticles}    reverse={true} />
      </div>

      {/* The three flow numerals — splash large across the bottom */}
      <div className="grid grid-cols-3 gap-6 mt-8">
        <FlowStat
          label="Solar"
          value={pvFmt.value}
          unit={pvFmt.unit}
          accent="var(--opus-solar)"
          subline={pv > 0 ? 'generating' : 'dark'}
        />
        <FlowStat
          label="Storage"
          value={fmtPct(soc, 0)}
          unit=""
          accent="var(--opus-storage)"
          subline={storageDir === 'in' ? `+${Math.round(Math.abs(storageNet))} W` : `−${Math.round(Math.abs(storageNet))} W`}
        />
        <FlowStat
          label="Loads"
          value={loadFmt.value}
          unit={loadFmt.unit}
          accent="var(--opus-load)"
          subline={load > 0 ? 'consuming' : 'idle'}
        />
      </div>
    </div>
  );
}

/* ─── sphere ─────────────────────────────────────────────────────── */

interface SphereProps {
  socAngle: number;
  socColor: string;
  soc: number | null;
}

/**
 * The Genesis sphere. Three layers:
 *   1. Outer SoC ring (arc of a circle, sweep = SoC%)
 *   2. Inner soft glow (radial gradient)
 *   3. Center text: SoC + "FLEET STATE OF CHARGE"
 */
function Sphere({ socAngle, socColor, soc }: SphereProps) {
  const size = 220;
  const radius = (size - 24) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (socAngle / 360) * circumference;

  return (
    <div className="relative opus-breathe" style={{ width: size, height: size }}>
      {/* Backdrop radial glow */}
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(circle at center, ${socColor}33 0%, transparent 70%)`,
          filter: 'blur(20px)',
        }}
      />

      {/* SoC arc */}
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className="absolute inset-0">
        <defs>
          <linearGradient id="opus-soc-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%"   stopColor={socColor} stopOpacity="0.9" />
            <stop offset="100%" stopColor={socColor} stopOpacity="0.4" />
          </linearGradient>
          <filter id="opus-glow">
            <feGaussianBlur stdDeviation="2.5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Background ring (subtle) */}
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="2"
        />
        {/* SoC fill ring */}
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke="url(#opus-soc-grad)" strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          filter="url(#opus-glow)"
          style={{ transition: 'stroke-dashoffset 1.2s cubic-bezier(0.16, 1, 0.3, 1)' }}
        />

        {/* Inner core — soft filled circle */}
        <circle
          cx={size / 2} cy={size / 2} r={radius - 22}
          fill={socColor} fillOpacity="0.04"
        />
        <circle
          cx={size / 2} cy={size / 2} r={radius - 22}
          fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="1"
        />
      </svg>

      {/* Center text */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="opus-numeral opus-numeral-lg" style={{ color: socColor }}>
          {soc != null ? Math.round(soc) : '—'}
          <span className="opus-numeral-unit">%</span>
        </div>
        <div className="opus-label mt-1" style={{ fontSize: 9 }}>FLEET ENERGY</div>
      </div>
    </div>
  );
}

/* ─── orbit + particles ──────────────────────────────────────────── */

interface ParticleDef {
  key: string;
  delaySec: number;
  durSec: number;
}

function buildParticles(count: number, prefix: string): ParticleDef[] {
  const result: ParticleDef[] = [];
  const baseDur = 10; // seconds
  for (let i = 0; i < count; i++) {
    result.push({
      key: `${prefix}-${i}`,
      delaySec: -(i / count) * baseDur,  // negative delay = start staggered
      durSec: baseDur,
    });
  }
  return result;
}

interface OrbitProps {
  radius: number;
  color: string;
  particles: ParticleDef[];
  reverse: boolean;
}

function Orbit({ radius, color, particles, reverse }: OrbitProps) {
  return (
    <div
      className="absolute"
      style={{
        width: 0, height: 0, top: '50%', left: '50%',
        color,
        animationDirection: reverse ? 'reverse' : 'normal',
      }}
    >
      {/* Faint orbital trail */}
      <div
        style={{
          position: 'absolute',
          top: -radius, left: -radius,
          width: radius * 2, height: radius * 2,
          borderRadius: '50%',
          border: '1px dashed currentColor',
          opacity: 0.08,
        }}
      />
      {particles.map((p) => (
        <span
          key={p.key}
          className="opus-orbit-particle"
          style={{
            ['--r' as string]: `${radius}px`,
            ['--dur' as string]: `${p.durSec}s`,
            animationDelay: `${p.delaySec}s`,
            animationDirection: reverse ? 'reverse' : 'normal',
          }}
        />
      ))}
    </div>
  );
}

/* ─── flow stat block ────────────────────────────────────────────── */

interface FlowStatProps {
  label: string;
  value: string;
  unit: string;
  accent: string;
  subline: string;
}

function FlowStat({ label, value, unit, accent, subline }: FlowStatProps) {
  return (
    <div className="opus-glass-hover" style={{ padding: '20px 16px', borderRadius: 12 }}>
      <div className="flex items-center gap-2 mb-3">
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: accent, boxShadow: `0 0 8px ${accent}` }} />
        <div className="opus-label">{label}</div>
      </div>
      <div className="opus-numeral opus-numeral-md" style={{ color: 'rgb(var(--color-ink))' }}>
        {value}
        {unit && <span className="opus-numeral-unit">{unit}</span>}
      </div>
      <div className="mt-2 text-xs" style={{ color: 'rgb(var(--color-muted))' }}>{subline}</div>
    </div>
  );
}

/* ─── helpers ────────────────────────────────────────────────────── */

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
