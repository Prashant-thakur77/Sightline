export interface Figure {
  id: string;
  label: string;
  value: string;
  detail: string;
}

/**
 * The dashboard's headline numbers as text, on a ticket like the readback: computed on the server
 * from the same rows Studio draws, and read in order by a screen reader before the dashboard.
 */
export function FiguresTicket({
  headingId,
  heading,
  asOf,
  figures,
  stub,
}: {
  headingId: string;
  heading: string;
  asOf: string;
  figures: Figure[];
  stub: string;
}) {
  return (
    <section className="sx-receipt" aria-labelledby={headingId}>
      {/* The date is shown beside the heading but kept out of its name: "The figures", then "As of …". */}
      <div className="sx-receipt-h">
        <h2 id={headingId} className="sx-receipt-title">
          {heading}
        </h2>
        <p className="sx-receipt-asof">
          <span className="sr-only">As of </span>
          {asOf}
        </p>
      </div>
      <dl className="sx-figures">
        {figures.map((f) => (
          <div key={f.id} className="sx-figure">
            <dt>{f.label}</dt>
            <dd>
              <span className="sx-fig-value">{f.value}</span>
              <span className="sx-fig-detail">{f.detail}</span>
            </dd>
          </div>
        ))}
      </dl>
      <p className="sx-stub">
        <span>{stub}</span>
        <span className="sx-keep" aria-hidden="true">
          KEEP
        </span>
      </p>
    </section>
  );
}
