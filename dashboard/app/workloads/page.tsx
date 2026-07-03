import { github } from '../../lib/server';
import { listWorkloads } from '../../lib/github/workloads';
import { checkReadiness, unmetItems } from '../../../scripts/gates/lib/readiness';
import { introduceAction, activateAction } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * Portfolio + intake (T139 tracer surface): readiness banner with intake
 * refusal (FR-029), introduce (title-only valid, FR-031), activate via the
 * gated lifecycle path, per-workload state (FR-032/FR-045).
 */
export default async function WorkloadsPage() {
  const { gh, repo } = github();
  const [workloads, readiness] = await Promise.all([listWorkloads(gh, repo), checkReadiness(gh, repo)]);
  const unmet = unmetItems(readiness);
  const ready = unmet.length === 0;

  return (
    <>
      <h1>Workloads</h1>
      {!ready && (
        <div style={{ border: '2px solid #c53030', borderRadius: 8, padding: '1rem', marginBottom: '1rem', background: '#fff5f5' }}>
          <strong>System not ready — workload intake is refused until Day-1 initialization completes.</strong>
          <ul>{unmet.map((item) => <li key={item}>{item}</li>)}</ul>
          <p style={{ margin: 0 }}>Run <code>npm run init</code> then <code>npm run init -- --verify</code> (quickstart §1).</p>
        </div>
      )}

      <section style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '1rem', marginBottom: '1.5rem' }}>
        <h2 style={{ marginTop: 0 }}>Introduce workload</h2>
        <form action={introduceAction} style={{ display: 'flex', gap: '0.5rem' }}>
          <input name="slug" placeholder="slug (e.g. demo)" required pattern="[a-z0-9][a-z0-9-]*" disabled={!ready} />
          <input name="title" placeholder="one-line title (optional)" style={{ flex: 1 }} disabled={!ready} />
          <button type="submit" disabled={!ready}>Introduce</button>
        </form>
      </section>

      {workloads.length === 0 && <p>No workloads yet.</p>}
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <tbody>
          {workloads.map((w) => (
            <tr key={w.slug} style={{ borderBottom: '1px solid #e2e8f0' }}>
              <td style={{ padding: '0.5rem 0' }}><strong>{w.slug}</strong></td>
              <td>{w.title}</td>
              <td><code>workload:{w.state ?? 'INVALID (SC-011 violation)'}</code></td>
              <td>
                {w.state === 'proposed' && (
                  <form action={activateAction} style={{ display: 'inline' }}>
                    <input type="hidden" name="slug" value={w.slug} />
                    <button type="submit">Activate</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
