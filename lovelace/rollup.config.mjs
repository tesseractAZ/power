import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';

const isDev = process.env.NODE_ENV === 'development';

/**
 * One bundle per card plus the standalone test harness. Each card bundle
 * tree-shakes independently — primitives that aren't used in a card don't
 * bloat its output. Output goes ONLY to the new file names; legacy
 * dist/ecoflow-panel-card.js and dist/ecoflow-panel-dashboard.js are NOT
 * touched.
 *
 * The test bundle is ESM (not IIFE) so it can do `import` inside the
 * browser test harness; it's not minified so failures are readable.
 */
const cardBundles = [
  { input: 'src/cards/fleet-card.ts', output: 'dist/ecoflow-fleet-card.js', name: 'EcoflowFleetCard' },
  { input: 'src/cards/alerts-card.ts', output: 'dist/ecoflow-alerts-card.js', name: 'EcoflowAlertsCard' },
  { input: 'src/cards/battery-card.ts', output: 'dist/ecoflow-battery-card.js', name: 'EcoflowBatteryCard' },
  { input: 'src/cards/solar-card.ts', output: 'dist/ecoflow-solar-card.js', name: 'EcoflowSolarCard' },
  // v0.9.54 — second-wave ports of items originally deferred as PWA-only.
  { input: 'src/cards/strategy-card.ts', output: 'dist/ecoflow-strategy-card.js', name: 'EcoflowStrategyCard' },
  { input: 'src/cards/insights-card.ts', output: 'dist/ecoflow-insights-card.js', name: 'EcoflowInsightsCard' },
  { input: 'src/cards/circuit-card.ts', output: 'dist/ecoflow-circuit-card.js', name: 'EcoflowCircuitCard' },
].map(({ input, output, name }) => ({
  input,
  output: {
    file: output,
    format: 'iife',
    name,
    sourcemap: true,
  },
  plugins: [
    nodeResolve(),
    typescript({
      tsconfig: './tsconfig.json',
      compilerOptions: { noEmit: false },
    }),
    ...(isDev ? [] : [terser()]),
  ],
}));

const testBundle = {
  input: 'test/snapshot-store.test.ts',
  output: {
    file: 'dist/snapshot-store.test.js',
    format: 'es',
    sourcemap: true,
  },
  plugins: [
    nodeResolve(),
    typescript({
      tsconfig: './tsconfig.json',
      compilerOptions: { noEmit: false },
    }),
  ],
};

export default [...cardBundles, testBundle];
