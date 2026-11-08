import { studioTheme } from 'ag-studio';

/*
 * AG Studio, re-cut with the design tokens from globals.css. Every colour is a CSS custom property,
 * so Studio follows the light, dark and high-contrast themes with the rest of the page. Chart colours
 * come from the --sx-chart-* tokens in studio.css, chosen so no series colour stands for a status:
 * verdicts are told apart by their words and shapes, never by red or green.
 */

const v = (name: string) => `var(--${name})`;
const line = (width: number, color: string) => ({ width, color: v(color) });

const SERIES = 6;
const palette = Object.fromEntries(
  Array.from({ length: 20 }, (_, i) => [
    [`chartPaletteFills${i + 1}Color`, v(`sx-chart-${(i % SERIES) + 1}`)],
    [`chartPaletteStrokes${i + 1}Color`, v('sx-chart-stroke')],
  ]).flat(),
);

export const sightlineStudioTheme = studioTheme.withParams({
  fontFamily: v('font-sans'),
  fontSize: 16,
  fontWeight: 400,
  lineHeight: 22,
  textColor: v('ink'),
  foregroundColor: v('ink'),
  subtleTextColor: v('muted'),
  backgroundColor: v('paper'),
  borderColor: v('hairline'),
  borderWidth: 2,
  borderRadius: 12,
  accentColor: v('signal'),
  iconColor: v('ink'),
  invalidColor: v('mismatch'),
  rowHoverColor: v('paper-2'),
  focusShadow: { spread: 4, color: v('focus-outer') },
  browserColorScheme: 'inherit',
  menuBackgroundColor: v('paper'),
  menuTextColor: v('ink'),
  menuBorder: line(2, 'line'),
  tooltipBackgroundColor: v('ink'),
  tooltipTextColor: v('paper'),
  tooltipBorder: line(2, 'ink'),
  scrollbarThumbColor: v('muted'),

  // Narrow screens: the canvas re-flows instead of forcing a sideways scroll.
  studioMinWidth: 0,
  studioMinHeight: 0,
  studioResponsiveMinWidth: 0,
  studioCanvasMinWidth: 0,

  // No frame of its own: the section around it draws the edge.
  studioWrapperBorder: false,
  studioWrapperBorderRadius: 0,
  studioWrapperSpacing: 0,
  studioWrapperBackgroundColor: v('paper'),
  studioCanvasBorder: false,
  studioCanvasBorderRadius: 0,
  studioCanvasShadow: false,
  studioCanvasBackgroundColor: v('paper'),
  studioCanvasPadding: 4,
  studioCanvasRowHeight: 18,
  studioCanvasFontFamily: v('font-sans'),
  studioCanvasGridLineColor: v('hairline'),

  // Widgets are cards: paper, a hard ink edge, the card radius.
  studioWidgetBackgroundColor: v('paper'),
  studioWidgetBorder: line(3, 'line'),
  studioWidgetBorderRadius: 22,
  studioWidgetPadding: 16,
  studioWidgetShadow: false,
  studioWidgetTitleFontFamily: v('font-sans'),
  studioWidgetTitleFontSize: 18,
  studioWidgetTitleFontWeight: 800,
  studioWidgetTitleTextColor: v('ink'),
  studioWidgetSubtitleFontFamily: v('font-sans'),
  studioWidgetSubtitleFontSize: 15,
  studioWidgetSubtitleTextColor: v('muted'),
  studioWidgetCaptionFontFamily: v('font-sans'),
  studioWidgetCaptionFontSize: 15,
  studioWidgetCaptionTextColor: v('muted'),
  studioWidgetResizeBorderColor: v('signal'),
  studioWidgetSelectedBorderColor: v('signal'),
  studioWidgetToolbarBackgroundColor: v('paper'),
  studioWidgetToolbarBorder: line(2, 'line'),
  studioWidgetToolbarButtonColor: v('ink'),
  studioWidgetToolbarButtonHoverBackgroundColor: v('paper-2'),
  studioWidgetLoadingOverlayBackgroundColor: v('paper'),
  studioWidgetNoDataOverlayBackgroundColor: v('paper'),
  studioValueWidgetFontSize: 44,
  studioTextWidgetFontSize: 16,

  // Edit-mode panels: paper-2, like the merchant console's side panels.
  studioPanelContainerBackgroundColor: v('paper-2'),
  studioPanelContainerBorder: line(2, 'line'),
  studioPanelContainerBorderRadius: 0,
  studioPanelDividerColor: v('hairline'),
  studioPanelDividerActiveColor: v('signal'),
  studioPanelSectionBorderColor: v('hairline'),
  studioPanelHeaderFontFamily: v('font-sans'),
  studioPanelHeaderFontWeight: 800,
  studioPanelChevronButtonHoverBackgroundColor: v('paper'),
  studioPanelChevronButtonHoverColor: v('ink'),
  studioPanelWidth: 260,
  studioAiPanelWidth: 360,
  studioToggleButtonActiveBackgroundColor: v('ink'),
  studioToggleButtonActiveBorderColor: v('ink'),
  studioToggleButtonActiveColor: v('paper'),
  studioIconButtonHoverBackgroundColor: v('paper-2'),
  studioIconButtonHoverColor: v('ink'),
  studioPopupBackgroundColor: v('paper'),
  studioPopupTitleBarBackgroundColor: v('paper-2'),
  studioPopupTitleBarTextColor: v('ink'),
  studioPopupTitleBarIconColor: v('ink'),

  // Grid widgets: the merchant console's grid, heavier headers and roomy rows.
  gridFontFamily: v('font-sans'),
  gridFontSize: 16,
  gridHeaderFontFamily: v('font-sans'),
  gridHeaderFontSize: 15,
  gridHeaderFontWeight: 800,
  gridHeaderBackgroundColor: v('paper-2'),
  gridHeaderTextColor: v('ink'),
  gridCellTextColor: v('ink'),
  gridDataBackgroundColor: v('paper'),
  gridOddRowBackgroundColor: v('paper'),
  gridAccentColor: v('signal'),
  gridIconColor: v('ink'),
  gridHeaderRowBorder: line(3, 'line'),
  gridRowBorder: line(1, 'hairline'),
  gridRowHeight: 44,
  gridHeaderHeight: 48,
  gridRowHoverColor: v('paper-2'),
  gridWrapperBorder: false,
  gridBrowserColorScheme: 'inherit',

  // Charts.
  chartFontFamily: v('font-sans'),
  chartFontSize: 15,
  chartTextColor: v('ink'),
  chartSubtleTextColor: v('muted'),
  chartAxisLineColor: v('line'),
  chartAxisLabelColor: v('ink'),
  chartAxisTitleColor: v('ink'),
  chartGridLineColor: v('hairline'),
  chartLegendLabelColor: v('ink'),
  chartTooltipBackgroundColor: v('paper'),
  chartTooltipTextColor: v('ink'),
  chartTooltipBorder: line(2, 'line'),
  chartSeriesLabelInsideTextColor: v('sx-chart-label-inside'),
  chartSeriesLabelOutsideTextColor: v('ink'),
  ...palette,
});
