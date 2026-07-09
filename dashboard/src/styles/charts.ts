// Obsidian Vault theme tokens for Recharts. Hex values mirror the
// CSS variables defined in dashboard/src/styles/obsidian-vault.css —
// keep both in sync if the palette is ever retuned.

export const CHART_COLORS = {
  primary: '#4f46e5',
  secondary: '#2DD4BF',
  success: '#2DD4BF',
  warning: '#FB923C',
  critical: '#F87171',
  info: '#4f46e5',

  palette: [
    '#4f46e5',
    '#2DD4BF',
    '#FB923C',
    '#F87171',
    '#6366f1',
    '#34D399',
    '#FBBF24',
    '#60A5FA',
  ],

  backgrounds: {
    dark: '#0A0A0D',
    surface: '#ffffff',   // slice/dot separators read white on light cards
    tertiary: '#1E1E2E',
  },

  text: {
    primary: '#E8E8F0',
    secondary: '#A0A0B8',
    tertiary: '#606080',
  },

  line: {
    stroke: '#4f46e5',
    fill: 'rgba(91, 126, 255, 0.1)',
    dot: '#4f46e5',
  },

  bar: {
    primary: '#4f46e5',
    hover: '#6366f1',
  },

  pie: {
    colors: ['#4f46e5', '#2DD4BF', '#FB923C', '#F87171', '#6366f1'],
  },
} as const

export const RECHARTS_CONFIG = {
  // Light-card values: a slate hairline grid + readable slate ticks. The
  // tooltip stays a crisp dark chip (matches the app's toasts) for contrast.
  gridStroke: '#e2e8f0',
  gridOpacity: 0.7,

  axisStroke: '#e2e8f0',
  axisTickFill: '#64748b',
  axisLabelFill: '#64748b',
  axisTickFontSize: 12,

  tooltipBackground: '#0f172a',
  tooltipBorder: '#334155',
  tooltipTextColor: '#e2e8f0',
  tooltipPadding: 12,
  tooltipBorderRadius: 6,

  cursorStroke: '#4f46e5',
  cursorOpacity: 0.5,

  legendTextColor: '#A0A0B8',
  legendFontSize: 12,
} as const

export const tooltipContentStyle = {
  backgroundColor: RECHARTS_CONFIG.tooltipBackground,
  border: `0.5px solid ${RECHARTS_CONFIG.tooltipBorder}`,
  borderRadius: RECHARTS_CONFIG.tooltipBorderRadius,
  padding: RECHARTS_CONFIG.tooltipPadding,
  boxShadow: 'none',
  color: RECHARTS_CONFIG.tooltipTextColor,
}

export const tickStyle = {
  fill: RECHARTS_CONFIG.axisTickFill,
  fontSize: RECHARTS_CONFIG.axisTickFontSize,
}

export const labelStyle = {
  fill: RECHARTS_CONFIG.axisLabelFill,
  fontSize: RECHARTS_CONFIG.axisTickFontSize,
  fontWeight: 500,
}
