/**
 * React glue for the StarfleetSoundEngine.
 *
 * Exposes: { engine, armed, muted, volume, setMuted, setVolume, arm }
 * and re-renders subscribers when any of those change.
 */

import { useEffect, useState, useCallback } from 'react';
import { getSoundEngine } from './sound';

export function useSound() {
  const engine = getSoundEngine();
  const [, force] = useState(0);
  useEffect(() => engine.subscribe(() => force((n) => n + 1)), [engine]);

  const arm = useCallback(() => {
    const ok = engine.arm();
    if (ok && !engine.isMuted()) engine.playStationChirp();
    return ok;
  }, [engine]);

  const setMuted = useCallback((muted: boolean) => {
    engine.setMuted(muted);
  }, [engine]);

  const setVolume = useCallback((volume: number) => {
    engine.setVolume(volume);
  }, [engine]);

  return {
    engine,
    armed: engine.isArmed(),
    muted: engine.isMuted(),
    volume: engine.getVolume(),
    arm,
    setMuted,
    setVolume,
  };
}

/**
 * Helper hook — fires `onChange` when the value crosses to a different
 * state. Used to drive Red/Yellow/Green alert sound transitions.
 */
export function useConditionTransition<T extends string>(
  level: T,
  onChange: (from: T | null, to: T) => void,
): void {
  const [prev, setPrev] = useState<T | null>(null);
  useEffect(() => {
    if (prev !== level) {
      onChange(prev, level);
      setPrev(level);
    }
  }, [level, prev, onChange]);
}
