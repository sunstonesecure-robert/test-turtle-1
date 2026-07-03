import { github } from '../../../lib/server';
import { getAndon } from '../../../lib/github/andon';
import { tryReadPlanAtRef } from '../../../lib/github/plans';
import { judgeAction, approveAction, openAndonAction } from '../../actions';

export const dynamic = 'force-dynamic';

/**
 * Andon review (T042/T043/T045 tracer surface): judgments list with per-item ✓,
 * plan rendered as data (never executed), and Commit-for-approval once every
 * item is judged. The ✗/correction composer lands with the first expansion.
 */
export default async function AndonReviewPage({ params }: { params: Promise<{ issue: string }> }) {
  const { issue } = await params;
  const issueNumber = Number(issue);
  const { gh, repo } = github();
  const andon = await getAndon(gh, repo, issueNumber);
  const { plan, errors } = await tryReadPlanAtRef(gh, repo, andon.planRef);
  const allJudged = andon.items.length > 0 && andon.items.every((i) => i.judged);
  const slugMatch = /^plan\/([a-z0-9-]+)\/v(\d+)$/.exec(andon.planRef);

  return (
    <>
      <h1>Andon #{issueNumber}</h1>
      <p>
        Plan <code>{andon.planRef}</code> · run <code>{andon.runId}</code> ·{' '}
        {andon.labels.filter((l) => l.startsWith('andon:')).map((l) => <code key={l}>{l}</code>)}
      </p>
      {andon.labels.includes('andon:open') && (
        <form action={openAndonAction}>
          <input type="hidden" name="issue" value={issueNumber} />
          <button type="submit">Open for review (→ under-review)</button>
        </form>
      )}

      <h2>Proposed plan</h2>
      {plan ? (
        <ul>
          {plan.steps.map((step) => (
            <li key={step.id}>
              <strong>{step.title}</strong> — {step.intent}
              <br />
              <small>
                acceptance: {step.acceptance} · <code>{step.priority}</code> · evidence: {step.evidence_tag}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ color: '#c53030' }}>plan.json failed validation: {errors.join('; ')}</p>
      )}

      <h2>Judgments required</h2>
      {andon.items.map((item) => (
        <div key={item.id} style={{ display: 'flex', gap: '0.75rem', alignItems: 'baseline', marginBottom: '0.5rem' }}>
          <span>{item.judged ? '✅' : '⬜'}</span>
          <code>{item.id}</code>
          <span style={{ flex: 1 }}>{item.description}</span>
          {!item.judged && (
            <form action={judgeAction}>
              <input type="hidden" name="issue" value={issueNumber} />
              <input type="hidden" name="item" value={item.id} />
              <button type="submit">✓ matches intent</button>
            </form>
          )}
        </div>
      ))}

      <h2>Approval</h2>
      {slugMatch && (
        <form action={approveAction}>
          <input type="hidden" name="issue" value={issueNumber} />
          <input type="hidden" name="slug" value={slugMatch[1]} />
          <input type="hidden" name="version" value={slugMatch[2]} />
          <button type="submit" disabled={!allJudged} title={allJudged ? '' : 'every item must be judged first (FR-005)'}>
            Commit for approval (opens PR)
          </button>
        </form>
      )}
      <p style={{ color: '#4a5568' }}>
        The go-ahead is merging the approval PR <strong>as yourself</strong> — that single merge freezes the
        plan, records you as approver, and resolves this Andon (FR-006/FR-007).
      </p>
    </>
  );
}
