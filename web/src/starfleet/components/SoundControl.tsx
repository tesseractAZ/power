/**
 * Audio control chip for the Starfleet bridge header.
 *
 * Three visual states:
 *   1. **UNARMED** — orange button, label "TAP TO ARM AUDIO". Browsers
 *      block AudioContext until a user gesture, so we explicitly require
 *      a click to enable sound at all.
 *   2. **ARMED + MUTED** — grey speaker-X icon, click to unmute.
 *   3. **ARMED + ON** — bright speaker icon, click to mute. Hover
 *      reveals a tiny volume slider below.
 */

import { useState } from 'react';
import { useSound } from '../useSound';

export function SoundControl() {
  const { armed, muted, volume, arm, setMuted, setVolume } = useSound();
  const [hovering, setHovering] = useState(false);

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => arm()}
        title="Browser audio is blocked until you click. Click to arm bridge alerts."
        style={{
          background: 'linear-gradient(180deg, #e89c40 0%, #a86018 100%)',
          color: '#1a120a',
          border: '1px solid #5a4520',
          borderRadius: 4,
          padding: '0.4rem 0.7rem',
          fontFamily: 'Antonio, sans-serif',
          fontWeight: 700,
          fontSize: 10,
          letterSpacing: '0.15em',
          textTransform: 'uppercase',
          boxShadow: 'inset 0 1px 0 rgb(255 220 160 / 0.6), 0 0 8px rgb(232 156 64 / 0.4)',
          cursor: 'pointer',
        }}
      >
        ◐ ARM AUDIO
      </button>
    );
  }

  return (
    <div
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{ position: 'relative' }}
    >
      <button
        type="button"
        onClick={() => setMuted(!muted)}
        title={muted ? 'Bridge audio muted — click to enable' : 'Bridge audio enabled — click to mute'}
        style={{
          background: muted
            ? 'linear-gradient(180deg, #3a2c1a 0%, #1a1208 100%)'
            : 'linear-gradient(180deg, #c8a878 0%, #8a7250 100%)',
          color: muted ? '#8c7a5c' : '#1a120a',
          border: '1px solid #5a4520',
          borderRadius: 4,
          padding: '0.4rem 0.7rem',
          fontFamily: 'Antonio, sans-serif',
          fontWeight: 700,
          fontSize: 10,
          letterSpacing: '0.15em',
          textTransform: 'uppercase',
          cursor: 'pointer',
          minWidth: 70,
        }}
      >
        {muted ? '◊ MUTE' : '◈ AUDIO'}
      </button>
      {hovering && !muted && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            background: '#0a0806',
            border: '1px solid #5a4520',
            borderRadius: 3,
            padding: '0.5rem 0.75rem',
            minWidth: 160,
            boxShadow: '0 4px 12px rgba(0,0,0,0.6)',
            zIndex: 50,
          }}
        >
          <div style={{
            fontFamily: 'Antonio, sans-serif',
            fontSize: 9,
            letterSpacing: '0.2em',
            color: '#8c7a5c',
            marginBottom: 4,
            textTransform: 'uppercase',
          }}>BRIDGE AUDIO · GAIN</div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            style={{ width: '100%', accentColor: '#e89c40' }}
          />
          <div style={{
            fontFamily: 'Share Tech Mono',
            fontSize: 10,
            color: '#e89c40',
            textAlign: 'right',
            marginTop: 2,
          }}>{Math.round(volume * 100)}%</div>
        </div>
      )}
    </div>
  );
}
