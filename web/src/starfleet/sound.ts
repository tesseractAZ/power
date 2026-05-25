/**
 * Starfleet bridge audio — TMP-era alert klaxons, chimes, and UI tones,
 * synthesized with the Web Audio API.
 *
 * No samples. Everything is generated from primitive oscillators +
 * gain envelopes, which keeps the bundle small AND avoids any
 * licensing entanglement with actual show audio.
 *
 * Sound design references (from memory / fan-audio analysis):
 *
 *   - Red Alert klaxon (TMP):
 *       Two-tone alternation ~440 Hz / ~660 Hz, square wave, ~250 ms each.
 *       Sharp attack, short release (no envelope smoothing — that's the
 *       "tinny urgent" character). Cycled 3× (~1.5 s), then silent.
 *   - Yellow Alert chime (TMP/TNG-era):
 *       Single bell tone, sine wave, soft attack + ~600 ms exponential
 *       decay. Two-step descending (880 → 660 Hz).
 *   - All-clear / station-engaged:
 *       Three-tone ascending sine sweep, A4 → D5 → A5, ~200 ms total.
 *       Soft, positive.
 *   - Communicator chirp (the "weeEEP"):
 *       Two ascending sines 660 → 880 Hz, ~150 ms total, sharp ramp.
 *   - Station-tab chirp (computer button click):
 *       50 ms square pulse at 1200 Hz, very low volume. Tactile feedback,
 *       not "alert".
 *
 * All sounds run through a master gain so the user can mute / volume-
 * down everything with one switch. Mute preference persists to
 * localStorage so the user's choice survives reload.
 */

/* ─── persistence ──────────────────────────────────────────────────── */

const STORAGE_KEY_MUTED = 'starfleet-audio-muted';
const STORAGE_KEY_VOLUME = 'starfleet-audio-volume';

function getStoredMuted(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY_MUTED) === '1';
  } catch {
    return false;
  }
}

function setStoredMuted(muted: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY_MUTED, muted ? '1' : '0');
  } catch { /* private mode — non-fatal */ }
}

function getStoredVolume(): number {
  if (typeof window === 'undefined') return 0.45;
  try {
    const v = Number(window.localStorage.getItem(STORAGE_KEY_VOLUME));
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.45;
  } catch {
    return 0.45;
  }
}

function setStoredVolume(volume: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY_VOLUME, String(volume));
  } catch { /* ignore */ }
}

/* ─── engine ──────────────────────────────────────────────────────── */

/**
 * Engine state. Tracks the AudioContext (lazily constructed on first
 * user gesture so we don't trip browser autoplay policies), the master
 * gain, and the currently-running red-alert loop so it can be stopped.
 *
 * `armed = false` means the user hasn't yet tapped anything that lets
 * us start an AudioContext. While unarmed, every `play*()` call no-ops.
 * Calling `arm()` from inside a user-gesture handler flips it on.
 */
export class StarfleetSoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private armed = false;
  private muted: boolean;
  private volume: number;
  private redAlertHandle: number | null = null;
  private listeners = new Set<() => void>();

  constructor() {
    this.muted = getStoredMuted();
    this.volume = getStoredVolume();
  }

  /* ── lifecycle ─────────────────────────────────────────────── */

  /**
   * Called from a user-gesture handler (button click). Constructs the
   * AudioContext and master gain. Idempotent — safe to call repeatedly.
   * Returns true if armed (now or already), false if construction failed.
   */
  arm(): boolean {
    if (this.armed) return true;
    if (typeof window === 'undefined') return false;
    const Ctor = (window.AudioContext || (window as any).webkitAudioContext) as
      typeof AudioContext | undefined;
    if (!Ctor) return false;
    try {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(this.ctx.destination);
      this.armed = true;
      this.notify();
      return true;
    } catch {
      return false;
    }
  }

  isArmed(): boolean { return this.armed; }
  isMuted(): boolean { return this.muted; }
  getVolume(): number { return this.volume; }

  setMuted(muted: boolean): void {
    this.muted = muted;
    setStoredMuted(muted);
    if (this.master) this.master.gain.value = muted ? 0 : this.volume;
    if (muted) this.stopRedAlert();
    this.notify();
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    setStoredVolume(this.volume);
    if (this.master && !this.muted) this.master.gain.value = this.volume;
    this.notify();
  }

  /** Subscribe to state changes — used by the React hook. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  /* ── primitive: one-shot tone ──────────────────────────────── */

  /**
   * Schedule a single tone at the given frequency. `type` selects the
   * oscillator wave (sine for chimes, square for klaxons). `attack` /
   * `decay` shape the gain envelope so we don't get speaker-popping
   * clicks at start/end.
   */
  private tone(
    freq: number,
    durMs: number,
    type: OscillatorType = 'sine',
    gain = 0.4,
    attackMs = 8,
    releaseMs = 30,
    delayMs = 0,
  ): void {
    if (!this.armed || this.muted || !this.ctx || !this.master) return;
    const t0 = this.ctx.currentTime + delayMs / 1000;
    const dur = durMs / 1000;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + attackMs / 1000);
    g.gain.setValueAtTime(gain, t0 + dur - releaseMs / 1000);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /**
   * Schedule a frequency-glide tone — used for the comm "weeEEP" sweep
   * and the all-clear ascending sweep.
   */
  private glide(
    f0: number,
    f1: number,
    durMs: number,
    type: OscillatorType = 'sine',
    gain = 0.4,
    delayMs = 0,
  ): void {
    if (!this.armed || this.muted || !this.ctx || !this.master) return;
    const t0 = this.ctx.currentTime + delayMs / 1000;
    const dur = durMs / 1000;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    g.gain.setValueAtTime(gain, t0 + dur - 0.04);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /* ── public alert sounds ───────────────────────────────────── */

  /**
   * Red Alert klaxon (TMP-era). Two-tone square-wave alternation:
   *   tone 1: 440 Hz, 250 ms
   *   tone 2: 660 Hz, 250 ms
   * Cycled 3× ≈ 1.5 s total. Re-callable to extend.
   *
   * Sharp attack/release on the gain envelope gives the characteristic
   * "tinny urgent" character that prevents the brain from filtering it
   * out as background hum.
   */
  playRedAlert(cycles = 3): void {
    if (!this.armed || this.muted) return;
    this.stopRedAlert();   // prevent overlap
    const stepMs = 250;
    const totalMs = cycles * 2 * stepMs;
    for (let i = 0; i < cycles; i++) {
      const t0 = i * 2 * stepMs;
      this.tone(440, stepMs, 'square', 0.35, 4, 8, t0);
      this.tone(660, stepMs, 'square', 0.35, 4, 8, t0 + stepMs);
    }
    this.redAlertHandle = window.setTimeout(() => {
      this.redAlertHandle = null;
    }, totalMs);
  }

  stopRedAlert(): void {
    if (this.redAlertHandle != null) {
      window.clearTimeout(this.redAlertHandle);
      this.redAlertHandle = null;
    }
  }

  /**
   * Yellow Alert chime. Descending two-step bell-tone, sine wave with
   * a soft attack + long-ish decay. Single play (no loop) — yellow alert
   * is "attention" not "emergency".
   */
  playYellowAlert(): void {
    if (!this.armed || this.muted) return;
    this.bellTone(880, 350, 0.35, 0);
    this.bellTone(660, 600, 0.35, 220);
  }

  /**
   * All-clear / "return to normal" — three-tone ascending sine sweep,
   * gentle and positive. Used on RED/YELLOW → GREEN transitions.
   */
  playAllClear(): void {
    if (!this.armed || this.muted) return;
    this.bellTone(440, 180, 0.28, 0);    // A4
    this.bellTone(587, 180, 0.28, 130);  // D5
    this.bellTone(880, 320, 0.28, 260);  // A5
  }

  /**
   * Communicator chime — the iconic "weeEEP" two-tone ascending sweep.
   * Used when a new info-level alert appears (subtle notification, not
   * alert-band escalation).
   */
  playComm(): void {
    if (!this.armed || this.muted) return;
    this.glide(660, 880, 140, 'sine', 0.30);
  }

  /**
   * Station-tab chirp. Single short square pulse at 1200 Hz. Low gain
   * (0.12) so it reads as tactile feedback, not "alert".
   */
  playStationChirp(): void {
    if (!this.armed || this.muted) return;
    this.tone(1200, 50, 'square', 0.12, 2, 8);
  }

  /**
   * Computer-acknowledge "working" double-tick — used optionally before
   * a heavy computation, like the TMP computer's pre-response affirmation.
   */
  playAck(): void {
    if (!this.armed || this.muted) return;
    this.tone(1500, 30, 'square', 0.10, 2, 6, 0);
    this.tone(1500, 30, 'square', 0.10, 2, 6, 70);
  }

  /* ── helpers ──────────────────────────────────────────────── */

  /** Bell-style tone — sine with sharp attack + slow exp decay. */
  private bellTone(freq: number, durMs: number, gain = 0.35, delayMs = 0): void {
    if (!this.armed || this.muted || !this.ctx || !this.master) return;
    const t0 = this.ctx.currentTime + delayMs / 1000;
    const dur = durMs / 1000;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }
}

/* ─── singleton ────────────────────────────────────────────────── */

let _engine: StarfleetSoundEngine | null = null;

export function getSoundEngine(): StarfleetSoundEngine {
  if (!_engine) _engine = new StarfleetSoundEngine();
  return _engine;
}
