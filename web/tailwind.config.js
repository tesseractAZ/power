/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Light industrial HMI / control-room palette.
        bg: '#c2c8d0', // console grey (behind panels)
        panel: '#eef0f3', // instrument-face (cards)
        panel2: '#dfe3e8', // recessed tiles / bar tracks
        line: '#9aa3b0', // panel seams / borders
        ink: '#1b2027', // primary text + readouts
        muted: '#586474', // secondary labels
        accent: '#0e7490', // instrument cyan
        ok: '#15803d', // status green
        warn: '#b45309', // status amber
        bad: '#b91c1c', // status red
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SF Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
