import { createClient } from '../dashboard/lib/github/client';
import { errorMessage } from '../dashboard/lib/github/errors';
import { planRefForMergedCommit } from './build-verify';

/**
 * "Is this commit a merged deliverable, and of which frozen plan?" — one line of
 * stdout, empty when the answer is no.
 *
 * A separate entry point rather than a mode of `build-verify.ts` because the verify
 * workflow needs the answer as a STEP OUTPUT before it decides whether to run
 * anything at all, and a script whose job is "print one value" must not also be the
 * script that writes a results file. Exits 0 either way: "this push was not a
 * deliverable merge" is the ordinary case, not a failure.
 */
const argv = process.argv.slice(2);
const get = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const [owner, repo] = (get('repo') ?? '').split('/');
const commit = get('commit');
if (!owner || !repo || !commit) {
  console.error('usage: build-verify-subject --repo <owner/repo> --commit <sha>');
  process.exit(2);
}
planRefForMergedCommit(createClient(), { owner, repo }, commit)
  .then((ref) => {
    // stdout is the value the workflow captures; everything explanatory goes to
    // stderr so the step output can never accidentally contain prose.
    if (ref === null) console.error(`commit ${commit.slice(0, 8)} is not a merged deliverable — nothing to verify`);
    else console.error(`commit ${commit.slice(0, 8)} is the merged deliverable of ${ref}`);
    process.stdout.write(`${ref ?? ''}\n`);
  })
  .catch((error) => {
    console.error(errorMessage(error));
    process.exit(1);
  });
