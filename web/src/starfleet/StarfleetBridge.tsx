/**
 * The Starfleet bridge — top-level component when theme=starfleet.
 *
 * Renders the iconic TMP-era bridge surround: warm tan header with
 * Starfleet delta + ship designation + stardate, station selector row,
 * then the active station's content panel area.
 *
 * Owns its own state for the active station; deliberately does NOT use
 * the existing tab/page state — Starfleet is a different organization
 * of the data.
 */

import { Component, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { useSnapshot } from '../useSnapshot';
import { DeltaShield } from './components/DeltaShield';
import { StationBar, type StationId } from './components/StationBar';
import { SoundControl } from './components/SoundControl';
import { stardate, shipDesignation, alertLevelFromCounts, type AlertLevel } from './utils';
import { useSound } from './useSound';
import { MainViewer } from './stations/MainViewer';
import { Conn } from './stations/Conn';
import { Engineering } from './stations/Engineering';
import { Science } from './stations/Science';
import { Tactical } from './stations/Tactical';
import { Ops } from './stations/Ops';
import { ThemeToggle } from '../components/ThemeToggle';

export function StarfleetBridge() {
  const { snapshot, conn } = useSnapshot();
  const [station, setStation] = useState<StationId>('cmd');
  const { engine } = useSound();

  const alerts = snapshot?.alerts ?? [];
  const crit = alerts.filter((a) => a.severity === 'critical').length;
  const warn = alerts.filter((a) => a.severity === 'warning').length;
  const level = alertLevelFromCounts(crit, warn);
  const ship = shipDesignation();

  /* v0.9.17 — Audible bridge alerts.
   *
   * We fire sounds on CONDITION TRANSITIONS, not continuously. The
   * previous level is tracked in a ref so we can compare frame-to-frame.
   * Sounds chosen for each transition:
   *
   *   ANY  → red   → Red Alert klaxon (TMP two-tone square cycle)
   *   green → yellow → Yellow Alert bell
   *   red/yellow → green → all-clear ascending chime
   *
   * The first render initializes prevLevel without firing — we don't
   * want to klaxon someone who arrives on a page that's already RED.
   * That's what `firstRender` guards.
   *
   * NEW CRIT WHILE ALREADY RED: the count is tracked, and a *higher*
   * critical count triggers another klaxon (someone should know a new
   * alarm fired). Going from 3 crit to 2 crit (one cleared) does not.
   */
  const prevLevelRef = useRef<AlertLevel | null>(null);
  const prevCritRef = useRef<number>(0);
  const firstRenderRef = useRef<boolean>(true);
  useEffect(() => {
    const prev = prevLevelRef.current;
    const prevCrit = prevCritRef.current;
    if (firstRenderRef.current) {
      // Don't fire on first render — just record where we landed.
      prevLevelRef.current = level;
      prevCritRef.current = crit;
      firstRenderRef.current = false;
      return;
    }
    if (prev !== level) {
      if (level === 'red') engine.playRedAlert();
      else if (level === 'yellow' && prev !== 'red') engine.playYellowAlert();
      else if (level === 'green') {
        engine.stopRedAlert();
        engine.playAllClear();
      }
    } else if (level === 'red' && crit > prevCrit) {
      // Same alert level (RED) but a NEW critical alarm just appeared.
      engine.playRedAlert(2); // shorter re-alert
    }
    prevLevelRef.current = level;
    prevCritRef.current = crit;
  }, [level, crit, engine]);

  /* Station-change chirp — fires on every tab switch (very low volume,
   * tactile feedback). Initial render is silent. */
  const prevStationRef = useRef<StationId | null>(null);
  const onChangeStation = useCallback((id: StationId) => {
    setStation(id);
    if (prevStationRef.current !== null) {
      engine.playStationChirp();
    }
    prevStationRef.current = id;
  }, [engine]);

  // v0.9.24 — derived footer status line. Reflects actual socket + alert
  // state instead of the previous always-"ALL DUTY STATIONS REPORTING".
  const footerStatus =
    conn !== 'open' ? 'SUBSPACE LINK · DEGRADED' :
    level === 'red' ? 'RED ALERT · DAMAGE CONTROL ENGAGED' :
    level === 'yellow' ? 'YELLOW ALERT · CONDITION ELEVATED' :
    'ALL DUTY STATIONS REPORTING';

  return (
    <div className="sf-bridge">
      {/*
        === Header banner (tan/jellybean console look) ===
        v0.9.24 — `flex-wrap` so the right-side cluster (stardate / registry
        / condition / sound / theme) can move to a second line on narrower
        viewports instead of cropping off the theme toggle. `min-w-0` on
        the ship-id column so it shrinks gracefully rather than pushing
        the right cluster off-screen.
      */}
      <header className="sf-header">
        <div className="max-w-[1800px] mx-auto px-4 py-3 flex items-center gap-4 flex-wrap">
          <DeltaShield size={48} color="#1a120a" glow={false} />
          <div className="flex flex-col min-w-0 flex-1" style={{ minWidth: 220 }}>
            {/* The prefix used to be one very long string ("UNITED FEDERATION
             * OF PLANETS · STARFLEET COMMAND") that letter-spacing puffed up
             * to wrap on three lines. Split it into two declared lines and
             * mark each `nowrap`. */}
            <div style={{ fontSize: 9, letterSpacing: '0.32em', fontWeight: 700, whiteSpace: 'nowrap' }}>UNITED FEDERATION OF PLANETS</div>
            <div style={{ fontSize: 9, letterSpacing: '0.32em', fontWeight: 700, whiteSpace: 'nowrap', opacity: 0.8 }}>STARFLEET COMMAND</div>
            <div style={{ fontFamily: 'Antonio, sans-serif', fontWeight: 700, fontSize: 22, letterSpacing: '0.12em', lineHeight: 1.1, whiteSpace: 'nowrap' }}>{ship.name}</div>
            <div style={{ fontSize: 10, letterSpacing: '0.18em', opacity: 0.75, whiteSpace: 'nowrap' }}>{ship.cls}</div>
          </div>
          <div className="ml-auto flex items-center gap-6 flex-shrink-0 flex-wrap justify-end">
            <div className="text-right">
              <div style={{ fontSize: 9, letterSpacing: '0.3em', fontWeight: 700 }}>STARDATE</div>
              <div style={{ fontFamily: 'Antonio, sans-serif', fontWeight: 700, fontSize: 22, lineHeight: 1 }}>{stardate()}</div>
            </div>
            <div className="text-right">
              <div style={{ fontSize: 9, letterSpacing: '0.3em', fontWeight: 700 }}>REGISTRY</div>
              <div style={{ fontFamily: 'Antonio, sans-serif', fontWeight: 700, fontSize: 22, lineHeight: 1 }}>{ship.registry}</div>
            </div>
            <div className="text-right">
              <div style={{ fontSize: 9, letterSpacing: '0.3em', fontWeight: 700 }}>CONDITION</div>
              <div style={{
                fontFamily: 'Antonio, sans-serif', fontWeight: 700, fontSize: 18, lineHeight: 1,
                color: level === 'red' ? '#c4242a' : level === 'yellow' ? '#a8581a' : '#3a5018',
              }}>{level === 'red' ? 'RED' : level === 'yellow' ? 'YELLOW' : 'GREEN'}</div>
            </div>
            <SoundControl />
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* === Station selector ========================================= */}
      <div className="max-w-[1800px] mx-auto">
        <StationBar
          active={station}
          onChange={onChangeStation}
          flags={{
            tac: crit > 0 || warn > 0 ? 'alert' : undefined,
          }}
        />
      </div>

      {/*
        === Active station content ===
        v0.9.24 — error boundary keyed on `station` so a thrown station
        (e.g. the Science crash before this release) renders an in-place
        panel instead of taking down the entire bridge. Switching tabs
        resets the boundary.
      */}
      <main className="max-w-[1800px] mx-auto px-4 pb-8">
        {!snapshot ? (
          <div className="sf-panel text-center py-12">
            <div className="sf-working" style={{ fontSize: 18 }}>ESTABLISHING SUBSPACE LINK · STAND BY…</div>
            <div className="sf-label mt-3">SOCKET: {conn}</div>
          </div>
        ) : (
          <StationErrorBoundary stationKey={station}>
            <StationContent station={station} snapshot={snapshot} />
          </StationErrorBoundary>
        )}
      </main>

      {/* === Footer === */}
      <footer className="max-w-[1800px] mx-auto px-4 py-3 flex items-center justify-between text-xs" style={{ borderTop: '1px solid #5a4520', color: '#8c7a5c' }}>
        <span style={{ fontFamily: 'Antonio, sans-serif', letterSpacing: '0.2em' }}>STARFLEET INTERFACE · TMP-ERA · {footerStatus}</span>
        <span style={{ fontFamily: 'Share Tech Mono', letterSpacing: '0.15em' }}>SOCK · {conn.toUpperCase()}</span>
      </footer>
    </div>
  );
}

/**
 * v0.9.24 — Station-level error boundary. Without this, a thrown render
 * inside Science / Conn / etc. propagates up through `<Suspense>` and
 * leaves the user with a fully blank screen. Now they see the bridge
 * chrome + a TMP-styled "MALFUNCTION" panel they can click off of.
 *
 * Re-keys on the station id so flipping tabs resets the boundary —
 * otherwise once a station errors, even other stations behind the same
 * boundary instance would be marked "broken".
 */
class StationErrorBoundary extends Component<{ stationKey: string; children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidUpdate(prev: { stationKey: string }) {
    if (prev.stationKey !== this.props.stationKey && this.state.err) {
      this.setState({ err: null });
    }
  }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="sf-panel" style={{ borderColor: '#c4242a', padding: '2rem' }}>
        <div className="sf-label" style={{ color: '#c4242a', fontSize: 12, marginBottom: 8 }}>● STATION MALFUNCTION</div>
        <div style={{ fontFamily: 'Antonio, sans-serif', fontSize: 18, color: '#f4e8c8' }}>
          {String(this.props.stationKey).toUpperCase()} CONSOLE OFFLINE
        </div>
        <div className="sf-label" style={{ fontSize: 10, marginTop: 8, color: '#8c7a5c', whiteSpace: 'pre-wrap' }}>
          {this.state.err?.message ?? 'unknown fault'}
        </div>
        <div className="sf-label" style={{ fontSize: 10, marginTop: 12, color: '#8c7a5c' }}>
          SELECT ANOTHER DUTY STATION OR RELOAD THE INTERFACE.
        </div>
      </div>
    );
  }
}

function StationContent({ station, snapshot }: { station: StationId; snapshot: any }) {
  switch (station) {
    case 'cmd':  return <MainViewer snapshot={snapshot} />;
    case 'conn': return <Conn snapshot={snapshot} />;
    case 'eng':  return <Engineering snapshot={snapshot} />;
    case 'sci':  return <Science snapshot={snapshot} />;
    case 'tac':  return <Tactical snapshot={snapshot} />;
    case 'ops':  return <Ops snapshot={snapshot} />;
  }
}
