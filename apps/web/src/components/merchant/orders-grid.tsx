'use client';

import type { ColDef } from 'ag-grid-community';
import type { CustomCellRendererProps } from 'ag-grid-react';
import type { MerchantOrderRow } from '@/server/merchant';
import { DataGrid, statusColumn } from './grid';
import { ShipmentStatus, variantText } from './orders-table';

/*
 * The orders as an interactive grid. Loaded on its own, only on wide screens and only after the
 * plain table has rendered, so the grid library never blocks the page.
 */

function ShipmentCell(p: CustomCellRendererProps<MerchantOrderRow, MerchantOrderRow['shipment']>) {
  return p.value ? <ShipmentStatus s={p.value} /> : null;
}

const COLUMNS: ColDef<MerchantOrderRow>[] = [
  {
    headerName: 'Order',
    field: 'ref',
    valueFormatter: (p) => `#${p.value}`,
    cellClass: 'mx-mono',
    width: 112,
    minWidth: 112,
  },
  { headerName: 'Buyer', field: 'buyer', width: 92, minWidth: 88 },
  { headerName: 'Item', field: 'item', flex: 1.3, minWidth: 160 },
  {
    headerName: 'Colour, size',
    colId: 'variant',
    valueGetter: (p) => (p.data ? variantText(p.data) : ''),
    width: 112,
    minWidth: 104,
  },
  {
    headerName: 'Amount',
    field: 'amountCents',
    valueFormatter: (p) => p.data?.amount ?? '',
    cellClass: 'mx-num',
    headerClass: 'mx-num-h',
    width: 100,
    minWidth: 96,
  },
  statusColumn<MerchantOrderRow>({ headerName: 'PayPal', field: 'payment', flex: 1, minWidth: 150 }),
  statusColumn<MerchantOrderRow>({
    headerName: 'Shipment',
    field: 'shipment',
    cellRenderer: ShipmentCell,
    flex: 1.1,
    minWidth: 170,
  }),
  statusColumn<MerchantOrderRow>({ headerName: 'Check', field: 'verdict', width: 160, minWidth: 150 }),
  statusColumn<MerchantOrderRow>({ headerName: 'Case', field: 'case', flex: 1, minWidth: 150 }),
];

export function OrdersGrid({
  rows,
  labelledBy,
  selectedId,
  onSelect,
  onReady,
}: {
  rows: MerchantOrderRow[];
  labelledBy: string;
  selectedId: string;
  onSelect: (id: string) => void;
  onReady?: () => void;
}) {
  return (
    <DataGrid
      rows={rows}
      columns={COLUMNS}
      labelledBy={labelledBy}
      selectedId={selectedId}
      onSelect={onSelect}
      onReady={onReady}
      autoHeight
    />
  );
}
