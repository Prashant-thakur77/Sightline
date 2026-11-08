import type { ChartTable } from './types';

/**
 * The data behind each chart on a dashboard, one disclosure per chart, rendered on the server from
 * the same rows the chart draws. The charts themselves are canvases with no text alternative.
 */
export function ChartTables({ id, tables }: { id: string; tables: ChartTable[] }) {
  if (!tables.length) return null;
  return (
    <section className="sx-data" aria-labelledby={`${id}-data-h`}>
      <h3 id={`${id}-data-h`} className="sx-data-h">
        The charts as tables
      </h3>
      {tables.map((t) => (
        <details key={t.id} className="sx-data-item">
          <summary>Data for {t.title}</summary>
          {t.rows.length ? (
            <table className="sx-data-table">
              <caption>
                <span className="sr-only">{t.title}: </span>
                {t.caption}
              </caption>
              <thead>
                <tr>
                  {t.columns.map((c) => (
                    <th key={c} scope="col">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {t.rows.map((r) => (
                  <tr key={r.key}>
                    <th scope="row">{r.cells[0]}</th>
                    {r.cells.slice(1).map((c, i) => (
                      <td key={t.columns[i + 1]}>{c}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="sx-data-empty">{t.empty}</p>
          )}
        </details>
      ))}
    </section>
  );
}
