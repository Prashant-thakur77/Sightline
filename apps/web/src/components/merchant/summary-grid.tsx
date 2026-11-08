'use client';

import type { ColDef } from 'ag-grid-community';
import { DataGrid } from './grid';

export interface SummaryRow {
  id: string;
  measure: string;
  value: string;
  how: string;
}

const COLUMNS: ColDef<SummaryRow>[] = [
  { headerName: 'Measure', field: 'measure', flex: 1, minWidth: 180 },
  {
    headerName: 'Value',
    field: 'value',
    cellClass: 'mx-num mx-strong',
    headerClass: 'mx-num-h',
    minWidth: 130,
    maxWidth: 200,
  },
  { headerName: 'How it is counted', field: 'how', flex: 2, minWidth: 240 },
];

export function SummaryGrid({ rows, labelledBy }: { rows: SummaryRow[]; labelledBy: string }) {
  return <DataGrid rows={rows} columns={COLUMNS} labelledBy={labelledBy} autoHeight />;
}
