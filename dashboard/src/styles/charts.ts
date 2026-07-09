// Central Recharts theme. Hex values MIRROR styles/tokens.css — Recharts/SVG
// need concrete colors, so keep these in sync with the CSS variables.

// Monochrome indigo ramp for the "Events by Type" donut — the one place
// categorical color is deliberately withheld (severity owns hue).
export const TYPE_RAMP = [
  '#312e81', '#3730a3', '#4338ca', '#4f46e5', '#6366f1', '#818cf8', '#a5b4fc',
] as const

// Severity is the ONLY categorical use of semantic hue.
export const SEVERITY_COLOR: Record<string, string> = {
  critical: '#dc2626',
  high: '#ea580c',
  medium: '#d0a215',
  low: '#64748b',
  info: '#64748b',
}

export function severityColor(s?: string): string {
  return SEVERITY_COLOR[(s || '').toLowerCase()] ?? '#7a808b'
}

/** Opacity for a chart segment: full unless a filter is active and this
 *  segment isn't the selected one, in which case it dims to 0.3. */
export function dimOpacity(hasSelection: boolean, isSelected: boolean): number {
  return !hasSelection || isSelected ? 1 : 0.3
}

// The theme object new code should consume.
export const CHART = {
  indigo: '#4f46e5',
  indigoDeep: '#4338ca',
  indigoLight: '#818cf8',
  blocked: '#a5b4fc', // lighter overlay line for the "blocked" series
  ramp: TYPE_RAMP,
  grid: '#e6e8ec', // --cs-hair
  axis: '#7a808b', // --cs-muted
  areaFrom: 0.28, // area gradient top opacity
  areaTo: 0.02, //   area gradient bottom opacity
  panel: '#ffffff', // slice/dot separators
  tooltipBg: '#1b1e26',
  tooltipBorder: '#2b2f3a',
  tooltipText: '#ffffff',
  tooltipMuted: '#9aa0aa',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
} as const

// ── Back-compat exports (consumed by Dashboard.tsx, CustomTooltip,
//    EventsTimeline). Values retuned to the light instrument theme. ──
export const CHART_COLORS = {
  primary: CHART.indigo,
  secondary: CHART.indigoLight,
  success: '#22a558',
  warning: '#d0a215',
  critical: '#dc2626',
  info: CHART.indigo,

  palette: [...TYPE_RAMP],

  backgrounds: {
    dark: '#0A0A0D',
    surface: CHART.panel, // white slice/dot separators on light cards
    tertiary: CHART.tooltipBorder,
  },

  text: {
    primary: CHART.tooltipText,   // for the dark tooltip
    secondary: '#cbd0d8',
    tertiary: CHART.tooltipMuted,
  },

  line: {
    stroke: CHART.indigo,
    fill: 'rgba(79, 70, 229, 0.12)',
    dot: CHART.indigo,
  },

  bar: {
    primary: CHART.indigo,
    hover: CHART.indigoLight,
  },

  pie: {
    colors: [...TYPE_RAMP],
  },
} as const

export const RECHARTS_CONFIG = {
  gridStroke: CHART.grid,
  gridOpacity: 1,

  axisStroke: CHART.grid,
  axisTickFill: CHART.axis,
  axisLabelFill: CHART.axis,
  axisTickFontSize: 11,

  tooltipBackground: CHART.tooltipBg,
  tooltipBorder: CHART.tooltipBorder,
  tooltipTextColor: CHART.tooltipText,
  tooltipPadding: 12,
  tooltipBorderRadius: 8,

  cursorStroke: CHART.indigo,
  cursorOpacity: 0.5,

  legendTextColor: CHART.axis,
  legendFontSize: 12,
} as const

export const tooltipContentStyle = {
  backgroundColor: RECHARTS_CONFIG.tooltipBackground,
  border: `1px solid ${RECHARTS_CONFIG.tooltipBorder}`,
  borderRadius: RECHARTS_CONFIG.tooltipBorderRadius,
  padding: RECHARTS_CONFIG.tooltipPadding,
  boxShadow: 'none',
  color: RECHARTS_CONFIG.tooltipTextColor,
  fontFamily: CHART.mono,
}

export const tickStyle = {
  fill: RECHARTS_CONFIG.axisTickFill,
  fontSize: RECHARTS_CONFIG.axisTickFontSize,
  fontFamily: CHART.mono,
}

export const labelStyle = {
  fill: RECHARTS_CONFIG.axisLabelFill,
  fontSize: RECHARTS_CONFIG.axisTickFontSize,
  fontWeight: 500,
}
