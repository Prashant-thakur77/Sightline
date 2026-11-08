'use client';

import { useEffect, useMemo, useRef } from 'react';
import { AgGridReact, type CustomCellRendererProps } from 'ag-grid-react';
import {
  CellStyleModule,
  ClientSideRowModelModule,
  ModuleRegistry,
  RowApiModule,
  RowAutoHeightModule,
  RowSelectionModule,
  RowStyleModule,
  ScrollApiModule,
  ValidationModule,
  themeQuartz,
  type ColDef,
  type GridApi,
  type GridOptions,
} from 'ag-grid-community';

ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  RowSelectionModule,
  RowAutoHeightModule,
  CellStyleModule,
  RowStyleModule,
  RowApiModule,
  ScrollApiModule,
  ...(process.env.NODE_ENV === 'production' ? [] : [ValidationModule]),
]);

/**
 * Quartz, re-cut with the design tokens. Every colour is a CSS custom property, so the grid
 * follows the light, dark and high-contrast themes without re-rendering.
 */
export const gridTheme = themeQuartz.withParams({
  fontFamily: 'var(--font-sans)',
  headerFontFamily: 'var(--font-sans)',
  fontSize: 17,
  headerFontSize: 15,
  headerFontWeight: 800,
  backgroundColor: 'var(--paper)',
  foregroundColor: 'var(--ink)',
  textColor: 'var(--ink)',
  subtleTextColor: 'var(--muted)',
  accentColor: 'var(--ink)',
  borderColor: 'var(--hairline)',
  chromeBackgroundColor: 'var(--paper-2)',
  headerBackgroundColor: 'var(--paper-2)',
  headerTextColor: 'var(--ink)',
  headerCellHoverBackgroundColor: 'var(--paper-2)',
  headerRowBorder: { width: 3, color: 'var(--line)' },
  headerColumnBorder: false,
  rowBorder: { width: 2, color: 'var(--hairline)' },
  columnBorder: false,
  wrapperBorder: { width: 3, color: 'var(--line)' },
  wrapperBorderRadius: 22,
  borderRadius: 12,
  rowHoverColor: 'var(--paper-2)',
  selectedRowBackgroundColor: 'var(--paper-2)',
  oddRowBackgroundColor: 'var(--paper)',
  rangeSelectionBorderColor: 'var(--focus-inner)',
  iconColor: 'var(--ink)',
  iconSize: 18,
  headerHeight: 56,
  rowHeight: 60,
  spacing: 8,
  cellHorizontalPadding: 12,
  browserColorScheme: 'inherit',
  focusShadow: { spread: 4, color: 'var(--focus-outer)' },
});

export interface Status {
  word: string;
  glyph: string;
  tone: string;
  short?: string;
}

/** A status as a word and a shape; the shape is decorative, the word carries the meaning. */
export function StatusChip({ s, short }: { s: Status; short?: boolean }) {
  return (
    <span className="mx-status" data-tone={s.tone}>
      <span className="mx-glyph" aria-hidden="true">
        {s.glyph}
      </span>
      <span>{short ? (s.short ?? s.word) : s.word}</span>
    </span>
  );
}

export function StatusCell(p: CustomCellRendererProps<unknown, Status>) {
  return p.value ? <StatusChip s={p.value} short /> : null;
}

export const statusColumn = <T,>(def: ColDef<T>): ColDef<T> => ({
  cellRenderer: StatusCell,
  comparator: (a: Status | null, b: Status | null) => (a?.word ?? '').localeCompare(b?.word ?? ''),
  ...def,
});

interface DataGridProps<T extends { id: string }> {
  rows: T[];
  columns: ColDef<T>[];
  /** Id of the heading that names the grid. */
  labelledBy: string;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** Rows with wrapped text grow to fit. */
  autoHeight?: boolean;
}

/**
 * One tab stop: Tab enters the grid on the focused cell and Tab again leaves it; arrow keys move
 * between cells. Enter or Space on any cell selects that row.
 */
export function DataGrid<T extends { id: string }>({
  rows,
  columns,
  labelledBy,
  selectedId,
  onSelect,
  autoHeight,
}: DataGridProps<T>) {
  const api = useRef<GridApi<T> | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const options = useMemo<GridOptions<T>>(
    () => ({
      theme: gridTheme,
      loadThemeGoogleFonts: false,
      domLayout: 'autoHeight',
      getRowId: (p) => p.data.id,
      defaultColDef: {
        cellDataType: false,
        sortable: true,
        resizable: true,
        suppressMovable: true,
        wrapText: true,
        wrapHeaderText: true,
        autoHeaderHeight: true,
        autoHeight: Boolean(autoHeight),
        minWidth: 88,
      },
      rowSelection: onSelect
        ? { mode: 'singleRow', checkboxes: false, enableClickSelection: true }
        : undefined,
      tabToNextCell: () => false,
      suppressDragLeaveHidesColumns: true,
      enableCellTextSelection: !onSelect,
      ensureDomOrder: true,
    }),
    [autoHeight, onSelect],
  );

  const nameGrid = () => {
    const el = wrap.current?.querySelector('[role="grid"], [role="treegrid"]');
    if (el && !el.getAttribute('aria-labelledby')) el.setAttribute('aria-labelledby', labelledBy);
  };

  useEffect(() => {
    const a = api.current;
    if (!a || !selectedId) return;
    const node = a.getRowNode(selectedId);
    if (node && !node.isSelected()) {
      node.setSelected(true, true, 'api');
      a.ensureNodeVisible(node);
    }
  }, [selectedId, rows]);

  return (
    <div ref={wrap} className="mx-grid">
      <AgGridReact<T>
        {...options}
        rowData={rows}
        columnDefs={columns}
        onGridReady={(e) => {
          api.current = e.api;
          nameGrid();
          if (selectedId) e.api.getRowNode(selectedId)?.setSelected(true, true, 'api');
        }}
        onFirstDataRendered={nameGrid}
        onSelectionChanged={(e) => {
          if (e.source === 'api') return;
          const id = e.api.getSelectedRows()[0]?.id;
          if (id) onSelect?.(id);
        }}
        onCellKeyDown={(e) => {
          const key = (e.event as KeyboardEvent | undefined)?.key;
          if (key === 'Enter' && onSelect && e.data) {
            e.node.setSelected(true, true, 'api');
            onSelect(e.data.id);
          }
        }}
      />
    </div>
  );
}
