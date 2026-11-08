import type {
  AgExpressionFieldDefinition,
  AgFieldDefinition,
  AgFormat,
  AgRelationDefinition,
  AgWidgetFieldReference,
  AgWidgetLayoutState,
} from 'ag-studio';
import { centsText, percentText } from './formats';

/* Small builders shared by the dashboards' data sources and report states. */

export type Spec = {
  id: string;
  name: string;
  format: AgFormat;
  description?: string;
  hide?: boolean;
  formatter?: (v: number) => string;
  blank?: string;
};

/** "Nov 7, 12:18 PM UTC": month in words, so it reads the same in every locale. */
const WHEN = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
});

export const field = ({ id, name, format, description, hide, formatter, blank }: Spec): AgFieldDefinition => ({
  id,
  name,
  format,
  ...(description && { description }),
  ...(hide && { hide }),
  ...(formatter && { createValueFormatter: () => formatter as (v: unknown) => string }),
  ...(format === 'dateTimeFormat' && { formatOptions: { format: WHEN } }),
  blankValue: blank ?? '–',
});

export const money = (id: string, name: string, description: string): Spec => ({
  id,
  name,
  format: 'currencyFormat',
  description: `${description} Stored as integer US cents: divide by 100 for dollars.`,
  formatter: centsText,
});
export const flag = (id: string, name: string, description: string): Spec => ({
  id,
  name,
  format: 'integerFormat',
  description: `${description} 1 for yes, 0 for no; sum it to count.`,
});

export const manyToOne = (id: string, from: string, to: string): AgRelationDefinition => {
  const [sourceTable, sourceField] = from.split('.') as [string, string];
  const [targetTable, targetField] = to.split('.') as [string, string];
  return {
    id,
    source: { tableId: sourceTable, fieldId: sourceField },
    target: { tableId: targetTable, fieldId: targetField },
    type: 'many-to-one',
  };
};

export const sum = (id: string): AgWidgetFieldReference => ({ id, aggregation: 'sum' });
export const count = (id: string): AgWidgetFieldReference => ({ id, aggregation: 'count' });

export const rate = (id: string, name: string, description: string, top: AgWidgetFieldReference, bottom: AgWidgetFieldReference): AgExpressionFieldDefinition => ({
  id,
  name,
  description,
  format: 'percentageFormat',
  isMeasure: true,
  expression: { operator: 'divide', inputs: [top, bottom] },
  createValueFormatter: () => percentText as (v: unknown) => string,
});

export const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number): AgWidgetLayoutState => ({ xTrack, yTrack, xSpan, ySpan });
export const title = (text: string, caption?: string) => ({
  title: { enabled: true, text, wrapping: true },
  ...(caption && { caption: { enabled: true, text: caption, wrapping: true } }),
});

export const kpi = (text: string, value: AgWidgetFieldReference, caption: string) => ({
  type: 'value' as const,
  dataMapping: { value: [value] },
  format: {
    ...title(text, caption),
    // A KPI's value sits right under its title: a wrapped title would run into it, so it shortens instead.
    title: { enabled: true, text, wrapping: false },
    style: { verticalAlign: 'center' as const, textAlign: 'left' as const },
  },
});

export const outlined = { custom: { seriesStroke: { enabled: true, strokeWidth: 2 } } };
