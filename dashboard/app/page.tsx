import { github } from '../lib/server';
import { openAndonAction } from './actions';

export const dynamic = 'force-dynamic';

/** Needs-validation inbox (T041, FR-001): every andon:open break, unmistakably. */
export default async function InboxPage() {
  const { gh, repo } = github();
  const [{ data: open }, { data: underReview }] = await Promise.all([
    gh.issues.listForRepo({ ...repo, labels: 'andon:open', state: 'open', per_page: 50 }),
    gh.issues.listForRepo({ ...repo, labels: 'andon:under-review', state: 'open', per_page: 50 }),
  ]);

  return (
    <>
      <h1>Inbox</h1>
      {open.length === 0 && underReview.length === 0 && <p>Nothing needs your validation right now.</p>}
      {open.map((issue) => (
        <div key={issue.number} style={{ border: '2px solid #dd6b20', borderRadius: 8, padding: '1rem', marginBottom: '0.75rem' }}>
          <strong>Needs validation — Andon #{issue.number}</strong>
          <p style={{ margin: '0.5rem 0' }}>{issue.title}</p>
          <form action={openAndonAction} style={{ display: 'inline' }}>
            <input type="hidden" name="issue" value={issue.number} />
            <button type="submit">Open for review</button>
          </form>{' '}
          <a href={`/andon/${issue.number}`}>View</a>
        </div>
      ))}
      {underReview.map((issue) => (
        <div key={issue.number} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '1rem', marginBottom: '0.75rem' }}>
          Under review — <a href={`/andon/${issue.number}`}>Andon #{issue.number}: {issue.title}</a>
        </div>
      ))}
    </>
  );
}
