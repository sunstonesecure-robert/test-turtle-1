import { readFile } from 'node:fs/promises';
import { createClient } from '../dashboard/lib/github/client';
import { recordEvidenceBatch, type EvidenceItem, type EvidenceKind } from '../dashboard/lib/github/evidence';
import { errorMessage } from '../dashboard/lib/github/errors';

/**
 * evidence-collect CLI — invoked by the evidence-collect workflow (FR-021).
 * Records the dated batch shell (committed JSON + evidence:batch issue); the
 * operator reviews and marks contradictions on the dashboard. The date comes
 * from the runner's clock at collection time — that IS the interval record.
 */

const KINDS: EvidenceKind[] = ['feedback', 'analytics', 'test-results'];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    const v = i >= 0 ? argv[i + 1] : undefined;
    return v && v.length > 0 ? v : undefined;
  };
  const repoArg = get('repo');
  const source = get('source') ?? 'scheduled';
  const kind = (get('kind') ?? 'feedback') as EvidenceKind;
  if (!repoArg || !KINDS.includes(kind)) {
    console.error(`usage: evidence-collect --source <name> --kind <${KINDS.join('|')}> --repo <owner/repo> [--date YYYY-MM-DD] [--items <file.json>]`);
    process.exit(2);
  }
  const [owner, repoName] = repoArg.split('/');
  if (!owner || !repoName) {
    console.error(`invalid --repo: ${repoArg}`);
    process.exit(2);
  }
  const date = get('date') ?? new Date().toISOString().slice(0, 10);
  // Observations ride in via --items <file.json> ([{summary, relates_to?}]) —
  // the configured source drops them for the run to pick up. Without it the
  // batch is an empty interval record ("nothing arrived this interval" is
  // itself a record), but the payload path must exist or every scheduled
  // batch is permanently empty (PR #74 bot finding).
  let items: EvidenceItem[] = [];
  const itemsPath = get('items');
  if (itemsPath) {
    const parsed = JSON.parse(await readFile(itemsPath, 'utf8'));
    if (!Array.isArray(parsed) || parsed.some((i) => typeof i?.summary !== 'string')) {
      console.error(`--items ${itemsPath}: expected [{summary, relates_to?}]`);
      process.exit(2);
    }
    items = parsed as EvidenceItem[];
  }
  const { issueNumber, path } = await recordEvidenceBatch(createClient(), { owner, repo: repoName }, {
    date,
    source,
    kind,
    items,
  });
  console.log(`evidence batch ${date}: ${path} · issue #${issueNumber} · ${items.length} item(s)`);
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exit(1);
});
