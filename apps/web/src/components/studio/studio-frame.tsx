'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  AgStudioAiModule,
  enableStudioDevValidations,
  type AgAiHarnessSetup,
  type AgDataSourcesDefinition,
  type AgPanelConfig,
  type AgReportState,
  type AgResponsiveLayoutBreakpoint,
  type AgStudioApi,
  type AgStudioMode,
  type AgWidgetLayoutState,
} from 'ag-studio';
import { AgStudio, AgStudioProvider } from 'ag-studio-react';
import { useAnnouncer } from '@/components/a11y/announcer';
import { sightlineStudioTheme } from './theme';
import type { StudioAgentStatus } from './types';
import './studio.css';

if (process.env.NODE_ENV !== 'production') enableStudioDevValidations();

/** Row height in px; matches studioCanvasRowHeight in the theme. */
const ROW = 18;
/** Below this canvas width the widgets stack in one column, in reading order. */
const STACK_BELOW = 760;

/** Widgets in reading order: top to bottom, then left to right. */
function readingOrder<T extends { layout: AgWidgetLayoutState }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.layout.yTrack - b.layout.yTrack || a.layout.xTrack - b.layout.xTrack);
}

const BREAKPOINTS: AgResponsiveLayoutBreakpoint[] = [
  {
    maxWidth: STACK_BELOW - 1,
    layout: (candidates, { columns }) => {
      const order = readingOrder(candidates.map((c, i) => ({ ...c, i })));
      const out: AgWidgetLayoutState[] = new Array(candidates.length);
      let y = 0;
      for (const c of order) {
        const ySpan = Math.max(c.layout.ySpan, c.minSize.ySpan);
        out[c.i] = { xTrack: 0, yTrack: y, xSpan: columns, ySpan };
        y += ySpan;
      }
      return out;
    },
  },
];

function rowsFor(report: AgReportState, stacked: boolean): number {
  const page = report.pages.find((p) => p.id === report.selectedPageId) ?? report.pages[0];
  const boxes = Object.values(page?.widgetLayout ?? {}).filter((b): b is AgWidgetLayoutState => Boolean(b));
  if (stacked) return boxes.reduce((a, b) => a + b.ySpan, 0);
  return boxes.reduce((a, b) => Math.max(a, b.yTrack + b.ySpan), 0);
}

const noSubscription = () => () => {};

/** The width of the box Studio draws in, so the page knows when Studio stacks its widgets. */
function useBoxWidth(): [(el: HTMLDivElement | null) => void, number | null] {
  const [width, setWidth] = useState<number | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export interface StudioFrameProps {
  /** Prefix for element ids on the page. */
  id: string;
  title: string;
  data: AgDataSourcesDefinition;
  report: AgReportState;
  licenseKey?: string;
  agent: StudioAgentStatus;
  /** Built only when the server has an Anthropic key; otherwise the assistant is not offered. */
  harness?: AgAiHarnessSetup;
}

export function StudioFrame({ id, title, data, report, licenseKey, agent, harness }: StudioFrameProps) {
  const inBrowser = useSyncExternalStore(noSubscription, () => true, () => false);
  const [boxRef, width] = useBoxWidth();
  const [mode, setMode] = useState<AgStudioMode>('view');
  const { announce } = useAnnouncer();
  const stacked = width !== null && width < STACK_BELOW;
  const rows = rowsFor(report, stacked);
  // Studio sizes to this box; the box is as tall as the layout so the page scrolls, not Studio.
  const height = mode === 'edit' ? 'max(760px, 85vh)' : `${rows * ROW + 8}px`;
  const ai = agent.enabled ? harness : undefined;
  const panels = useMemo<AgPanelConfig>(
    () => ({ view: {}, edit: { left: ['data'], right: ai ? ['ai', 'edit'] : ['edit'] } }),
    [ai],
  );
  const modules = useMemo(() => (ai ? [AgStudioAiModule] : undefined), [ai]);
  const api = useRef<AgStudioApi | null>(null);
  const folded = useRef(false);

  // The first time edit mode opens, fold the field list away so the canvas keeps its width. The
  // panels are only built on entering edit mode, so this is applied once they exist.
  useEffect(() => {
    if (mode !== 'edit' || folded.current || !api.current) return;
    folded.current = true;
    const studio = api.current;
    const t = window.setTimeout(() => {
      const state = studio.getState();
      studio.setState({ ...state, panels: { ...state.panels, data: { ...state.panels?.data, collapsed: true } } });
    }, 0);
    return () => window.clearTimeout(t);
  }, [mode]);

  const change = (next: AgStudioMode) => {
    if (next === mode) return;
    setMode(next);
    announce(
      next === 'edit'
        ? `Editing ${title}. Changes stay in this browser tab${ai ? '. The assistant panel is open' : ''}.`
        : `Viewing ${title}.`,
      { source: 'studio' },
    );
  };

  return (
    <div className="sx-frame">
      <div className="sx-bar">
        <div className="sx-modes" role="group" aria-label="Dashboard mode">
          <button type="button" className="sx-mode" aria-pressed={mode === 'view'} onClick={() => change('view')}>
            View
          </button>
          <button type="button" className="sx-mode" aria-pressed={mode === 'edit'} onClick={() => change('edit')}>
            {ai ? 'Edit and ask' : 'Edit'}
          </button>
        </div>
        <ul className="sx-notes">
          <li>
            <span className="sx-note-mark" aria-hidden="true">
              {ai ? '✓' : '–'}
            </span>
            {ai
              ? `Assistant on: answers come from Claude (${agent.model}), only about this dashboard. Open it with Edit and ask.`
              : 'Assistant off: this server has no Anthropic API key, so nothing is sent to a model. Every widget and the edit tools still work.'}
          </li>
          {!licenseKey && (
            <li>
              <span className="sx-note-mark" aria-hidden="true">
                –
              </span>
              No AG Studio licence key on this server, so Studio runs as a trial and shows a watermark outside local development. The numbers are the same.
            </li>
          )}
        </ul>
      </div>
      <a className="sx-skip" href={`#${id}-after`}>
        Skip past the dashboard
      </a>
      <div className="sx-canvas" ref={boxRef} style={{ height }} data-mode={mode}>
        {inBrowser ? (
          <AgStudioProvider licenseKey={licenseKey} modules={modules}>
            <AgStudio
              style={{ height: '100%', width: '100%' }}
              theme={sightlineStudioTheme}
              data={data}
              initialState={report}
              mode={mode}
              ai={ai}
              panels={panels}
              responsiveLayoutBreakpoints={BREAKPOINTS}
              layout={{ widgetBorderEnabled: true }}
              onApiReady={(e) => {
                api.current = e.api;
              }}
            />
          </AgStudioProvider>
        ) : (
          <p className="sx-loading">Loading the dashboard…</p>
        )}
      </div>
      <span id={`${id}-after`} tabIndex={-1} className="sx-after" />
    </div>
  );
}
