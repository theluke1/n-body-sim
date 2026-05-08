/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        'mc-bg':     'var(--bg)',
        'mc-panel':  'var(--bg-panel)',
        'mc-border': 'var(--border)',
        'mc-cyan':   'var(--cyan)',
        'mc-green':  'var(--green)',
        'mc-amber':  'var(--amber)',
        'mc-red':    'var(--red)',
        'mc-purple': 'var(--purple)',
        'mc-dim':    'var(--text-dim)',
        'mc-mono':   'var(--text-mono)',
      },
      fontFamily: {
        mono: ['Space Mono', 'Courier New', 'monospace'],
        ui:   ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
