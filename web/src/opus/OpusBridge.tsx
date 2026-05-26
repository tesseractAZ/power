/**
 * v0.9.40 — Project Genesis / Opus theme top-level shell.
 *
 * Lifeblood:
 *   - One opinionated landing screen ("Home") covering Living World +
 *     Alerts + Pack Vitals + Forecast + System Map.
 *   - Optional deep-dive sections accessed via the floating segmented
 *     control at top.
 *   - Status dock pinned at bottom.
 *
 * Visual language: deep cosmic backdrop, glass panels, hero typography,
 * organic gradients, breathing animations. Apple human-interface
 * sensibility — calm, deliberate, never urgent unless something IS.
 */

import { useState } from 'react';
import { useSnapshot } from '../useSnapshot';
import { ThemeToggle } from '../components/ThemeToggle';
import { LivingWorld } from './components/LivingWorld';
import { PackVitals } from './components/PackVitals';
import { ForecastCanvas } from './components/ForecastCanvas';
import { SystemMap } from './components/SystemMap';
import { AlertSurface } from './components/AlertSurface';
import { StatusDock } from './components/StatusDock';

type Section = 'home' | 'health' | 'forecast' | 'map';

export function OpusBridge() {
  const { snapshot, conn } = useSnapshot();
  const [section, setSection] = useState<Section>('home');

  return (
    <div className="opus-bridge">
      {/* Header — minimal, generous whitespace */}
      <header className="px-8 pt-8 pb-4 flex items-center justify-between">
        <div>
          <div className="opus-eyebrow">PROJECT GENESIS</div>
          <h1
            className="opus-numeral mt-1"
            style={{ fontSize: 32, fontWeight: 300, letterSpacing: '-0.02em' }}
          >
            Living World
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <SectionNav active={section} onChange={setSection} />
          <ThemeToggle />
        </div>
      </header>

      {/* Section content */}
      <main className="px-8 pb-32 max-w-[1440px] mx-auto">
        {section === 'home' && <HomeSection snapshot={snapshot} />}
        {section === 'health' && <HealthSection snapshot={snapshot} />}
        {section === 'forecast' && <ForecastSection />}
        {section === 'map' && <MapSection snapshot={snapshot} />}
      </main>

      <StatusDock conn={conn} />
    </div>
  );
}

/* ─── section nav ─────────────────────────────────────────────────── */

function SectionNav({ active, onChange }: { active: Section; onChange: (s: Section) => void }) {
  const items: Array<{ id: Section; label: string }> = [
    { id: 'home', label: 'Home' },
    { id: 'health', label: 'Health' },
    { id: 'forecast', label: 'Forecast' },
    { id: 'map', label: 'Map' },
  ];
  return (
    <div className="opus-pill-group">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`opus-pill ${active === item.id ? 'opus-pill-active' : ''}`}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/* ─── sections ────────────────────────────────────────────────────── */

function HomeSection({ snapshot }: { snapshot: ReturnType<typeof useSnapshot>['snapshot'] }) {
  return (
    <div className="flex flex-col gap-6">
      {/* Hero row: Living World takes the full width */}
      <LivingWorld snapshot={snapshot} />

      {/* Second row: 2-col grid (alerts left, forecast right) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <AlertSurface snapshot={snapshot} />
        <ForecastCanvas />
      </div>

      {/* Third row: Pack Vitals full-width */}
      <PackVitals snapshot={snapshot} />
    </div>
  );
}

function HealthSection({ snapshot }: { snapshot: ReturnType<typeof useSnapshot>['snapshot'] }) {
  return (
    <div className="flex flex-col gap-6">
      <PackVitals snapshot={snapshot} />
      <AlertSurface snapshot={snapshot} />
    </div>
  );
}

function ForecastSection() {
  return (
    <div className="flex flex-col gap-6">
      <ForecastCanvas />
    </div>
  );
}

function MapSection({ snapshot }: { snapshot: ReturnType<typeof useSnapshot>['snapshot'] }) {
  return (
    <div className="flex flex-col gap-6">
      <SystemMap snapshot={snapshot} />
    </div>
  );
}
