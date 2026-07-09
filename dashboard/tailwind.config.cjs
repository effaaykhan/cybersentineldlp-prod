/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        // Tied to the design tokens (styles/tokens.css) so there is a single
        // source of truth. `font-sans` / `font-mono` resolve to --cs-sans/mono.
        sans: ['var(--cs-sans)'],
        mono: ['var(--cs-mono)'],
      },
      colors: {
        // ── Design tokens (styles/tokens.css) surfaced as Tailwind colors ──
        // Use `bg-cs-panel`, `text-cs-ink`, `border-cs-hair`, `text-cs-crit`…
        cs: {
          bg: 'var(--cs-bg)',
          panel: 'var(--cs-panel)',
          hair: 'var(--cs-hair)',
          'hair-2': 'var(--cs-hair-2)',
          ink: 'var(--cs-ink)',
          'ink-2': 'var(--cs-ink-2)',
          muted: 'var(--cs-muted)',
          'muted-2': 'var(--cs-muted-2)',
          indigo: 'var(--cs-indigo)',
          'indigo-d': 'var(--cs-indigo-d)',
          'indigo-faint': 'var(--cs-indigo-faint)',
          crit: 'var(--cs-crit)',
          high: 'var(--cs-high)',
          med: 'var(--cs-med)',
          low: 'var(--cs-low)',
          ok: 'var(--cs-ok)',
        },
        // Single brand accent — indigo. The dashboard already leaned indigo
        // in places while `primary` was blue; unifying removes the split.
        primary: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
        },
        // Cool, calm canvas — a hair cooler and softer than flat gray-50.
        canvas: '#f6f7f9',
        danger: {
          50: '#fef2f2', 100: '#fee2e2', 200: '#fecaca', 300: '#fca5a5',
          400: '#f87171', 500: '#ef4444', 600: '#dc2626', 700: '#b91c1c',
          800: '#991b1b', 900: '#7f1d1d',
        },
        success: {
          50: '#f0fdf4', 100: '#dcfce7', 200: '#bbf7d0', 300: '#86efac',
          400: '#4ade80', 500: '#22c55e', 600: '#16a34a', 700: '#15803d',
          800: '#166534', 900: '#14532d',
        },
        warning: {
          50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d',
          400: '#fbbf24', 500: '#f59e0b', 600: '#d97706', 700: '#b45309',
          800: '#92400e', 900: '#78350f',
        },
      },
      boxShadow: {
        // Refined, low-contrast elevation — precision over softness.
        card: '0 1px 2px rgba(15,23,42,0.04), 0 1px 3px rgba(15,23,42,0.06)',
        'card-hover': '0 2px 8px rgba(15,23,42,0.06), 0 8px 24px rgba(15,23,42,0.08)',
        focus: 'var(--cs-focus)',
      },
      borderRadius: {
        'cs-card': 'var(--cs-r-card)',
        'cs-pill': 'var(--cs-r-pill)',
        'cs-sm': 'var(--cs-r-sm)',
      },
    },
  },
  plugins: [],
}
