import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';

const isDev = process.env.NODE_ENV === 'development';

/**
 * One config per card so each bundle tree-shakes independently.
 * Output goes ONLY to the new file names — legacy
 * dist/ecoflow-panel-card.js and dist/ecoflow-panel-dashboard.js
 * are NOT touched.
 */
const cards = [
  { input: 'src/cards/fleet-card.ts', output: 'dist/ecoflow-fleet-card.js', name: 'EcoflowFleetCard' },
];

export default cards.map(({ input, output, name }) => ({
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
      // rollup-emit overrides tsconfig noEmit
      compilerOptions: { noEmit: false },
    }),
    ...(isDev ? [] : [terser()]),
  ],
}));
