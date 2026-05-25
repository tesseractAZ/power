/**
 * Concentric ring gauge — the marquee TMP-era data display element.
 *
 * One outer ring (track), one fill arc (current value), one tick scale,
 * and a centred numeric readout. Optional inner concentric ring for a
 * secondary metric (e.g. setpoint marker).
 */

export interface RingGaugeProps {
  /** 0..100 main fill. */
  value: number;
  /** 0..100 setpoint to mark on the dial, optional. */
  setpoint?: number;
  /** SVG side length. */
  size?: number;
  /** Ring stroke width (px). */
  stroke?: number;
  /** Centre numeric (pre-formatted by caller). */
  centerNumber?: string;
  centerUnit?: string;
  centerLabel?: string;
  /** Tick count around the dial. */
  ticks?: number;
  /** Fill color. Caller may use jellybean palette. */
  fillColor?: string;
  trackColor?: string;
}

export function RingGauge({
  value,
  setpoint,
  size = 200,
  stroke = 14,
  centerNumber,
  centerUnit,
  centerLabel,
  ticks = 24,
  fillColor = '#e89c40',
  trackColor = '#3a2c1a',
}: RingGaugeProps) {
  const r = (size - stroke) / 2 - 6;          // inner radius for the gauge ring
  const cx = size / 2;
  const cy = size / 2;
  // Sweep from -135° (lower-left) to +135° (lower-right) for a 270° arc
  // — feels more "instrument dial" than a full circle, and gives space
  // at the bottom for the unit label.
  const startA = -225;
  const endA = 45;
  const totalSweep = endA - startA;            // 270°
  const valSweep = Math.max(0, Math.min(1, value / 100)) * totalSweep;
  const valEnd = startA + valSweep;

  const arcPath = (a0: number, a1: number) => {
    const large = a1 - a0 > 180 ? 1 : 0;
    const p0 = polar(cx, cy, r, a0);
    const p1 = polar(cx, cy, r, a1);
    return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} 1 ${p1.x} ${p1.y}`;
  };

  // Setpoint marker as a small tick on the dial.
  const setpointA = setpoint != null
    ? startA + Math.max(0, Math.min(1, setpoint / 100)) * totalSweep
    : null;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Concentric outer trim — the brass-edge look. */}
      <circle cx={cx} cy={cy} r={r + stroke / 2 + 2} fill="none" stroke="#5a4520" strokeWidth="1" />
      <circle cx={cx} cy={cy} r={r - stroke / 2 - 4} fill="none" stroke="#3a2c1a" strokeWidth="1" />

      {/* Background track (full 270° arc). */}
      <path
        d={arcPath(startA, endA)}
        fill="none"
        stroke={trackColor}
        strokeWidth={stroke}
        strokeLinecap="butt"
      />
      {/* Ticks around the dial. */}
      {Array.from({ length: ticks + 1 }, (_, i) => {
        const a = startA + (i / ticks) * totalSweep;
        const isMajor = i % 4 === 0;
        const inner = r - stroke / 2 - (isMajor ? 9 : 5);
        const outer = r - stroke / 2 - 1;
        const p0 = polar(cx, cy, inner, a);
        const p1 = polar(cx, cy, outer, a);
        return (
          <line
            key={i}
            x1={p0.x}
            y1={p0.y}
            x2={p1.x}
            y2={p1.y}
            stroke={isMajor ? '#8a7250' : '#5a4520'}
            strokeWidth={isMajor ? 1.5 : 1}
          />
        );
      })}
      {/* Fill arc for the current value. */}
      {valSweep > 0 && (
        <path
          d={arcPath(startA, valEnd)}
          fill="none"
          stroke={fillColor}
          strokeWidth={stroke}
          strokeLinecap="butt"
          style={{ filter: `drop-shadow(0 0 6px ${fillColor}aa)` }}
        />
      )}
      {/* Setpoint marker. */}
      {setpointA != null && (() => {
        const inner = r - stroke / 2 - 14;
        const outer = r - stroke / 2 - 1;
        const p0 = polar(cx, cy, inner, setpointA);
        const p1 = polar(cx, cy, outer, setpointA);
        return (
          <line
            x1={p0.x}
            y1={p0.y}
            x2={p1.x}
            y2={p1.y}
            stroke="#4a86c6"
            strokeWidth="2"
            strokeLinecap="round"
            style={{ filter: 'drop-shadow(0 0 4px #4a86c6)' }}
          />
        );
      })()}
      {/* Center text block. */}
      {centerNumber && (
        <text
          x={cx}
          y={cy + 2}
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily="Antonio, Bahnschrift, sans-serif"
          fontWeight="700"
          fontSize={size * 0.22}
          fill={fillColor}
          style={{ filter: `drop-shadow(0 0 4px ${fillColor}99)` }}
        >
          {centerNumber}
        </text>
      )}
      {centerUnit && (
        <text
          /* v0.9.24 — moved from cy + 0.16 to cy + 0.24 because the big
           * centerNumber + its glow drop-shadow overlapped the unit text,
           * leaving "PERCENT" only half-visible behind the "61.0". */
          x={cx}
          y={cy + size * 0.24}
          textAnchor="middle"
          fontFamily="Antonio, Bahnschrift, sans-serif"
          fontWeight="700"
          fontSize={size * 0.08}
          letterSpacing="0.2em"
          fill="#8c7a5c"
        >
          {centerUnit}
        </text>
      )}
      {centerLabel && (
        <text
          x={cx}
          y={cy - size * 0.20}
          textAnchor="middle"
          fontFamily="Antonio, Bahnschrift, sans-serif"
          fontWeight="700"
          fontSize={size * 0.06}
          letterSpacing="0.28em"
          fill="#8c7a5c"
        >
          {centerLabel}
        </text>
      )}
    </svg>
  );
}

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}
