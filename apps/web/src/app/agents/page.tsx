import Link from 'next/link';
import { AgentArt, HelperArt, StoreArt } from '@/components/art/illustrations';
import { PublicPage } from '@/components/landing/public-page';
import { AGENT } from '@/components/landing/content';

export const metadata = { title: 'The agents' };

export default function Agents() {
  return (
    <PublicPage
      path="/agents"
      kicker="The agents"
      title="An agent that works for you, and never pays without you."
      lede="Claude does the legwork: searching, comparing, remembering, checking and negotiating. Money only moves through steps you hear and confirm."
    >
      <section className="lx-section lx-agent" aria-labelledby="agent-h">
        <div className="lx-wrap lx-agent-grid">
          <div className="lx-agent-intro">
            <h2 id="agent-h" className="lx-h2">
              What your agent does
            </h2>
            <div className="lx-agent-art">
              <AgentArt />
            </div>
          </div>
          <ul className="lx-cards">
            {AGENT.map((a) => (
              <li key={a.title} className="lx-card">
                <h3>{a.title}</h3>
                <p>{a.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="lx-section lx-sides" aria-labelledby="sides-h">
        <div className="lx-wrap">
          <h2 id="sides-h" className="lx-h2">
            Fair to stores. Close to family.
          </h2>
          <ul className="lx-sides-grid">
            <li className="lx-side">
              <div className="lx-side-art">
                <StoreArt />
              </div>
              <h3>For stores</h3>
              <p>
                A case desk with the signed evidence, a store agent that proposes fixes within your rules, and dashboards that show what was checked
                and why. Honest buyers get paid-after-check; stores get fewer disputes.
              </p>
              <Link className="link-target" href="/merchant">
                Open the Demo Store console
              </Link>
            </li>
            <li className="lx-side">
              <div className="lx-side-art">
                <HelperArt />
              </div>
              <h3>For the people you trust</h3>
              <p>
                When the camera is not sure, send a private link. Your helper sees only the photos and the listing, never payment details, and answers
                with one press. The link expires in two days.
              </p>
            </li>
          </ul>
        </div>
      </section>
    </PublicPage>
  );
}
