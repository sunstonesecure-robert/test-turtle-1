/**
 * One snapshot, judged and merged — or nothing (GHI #320).
 *
 * A pull request is a moving thing: every read of it answers for the head as it is at
 * that moment. A reader that makes a decision over several reads — the merger deciding
 * merge authority, then running the gate, then waiting for checks, then merging — is
 * only sound if every one of those reads was about the SAME commit. The pin is how a
 * caller says which commit that is, and `HeadMovedError` is how a reader says "the
 * commit you asked me about is no longer the head, so I decided nothing".
 *
 * It is thrown, not returned as a red gate: a moved head is not a verdict about the
 * deliverable. Nothing is wrong with it. The answer is simply about a commit nobody is
 * proposing to merge any more, and the caller's next look judges the new one from
 * scratch.
 */
export interface PinnedHead {
  /** the commit the caller has already read and intends to merge */
  headSha: string;
  /** every path that commit's diff touches, as the caller read it for that commit */
  paths: string[];
}

export class HeadMovedError extends Error {
  constructor(
    readonly judged: string,
    readonly found: string,
  ) {
    super(`the pull request head moved from ${judged.slice(0, 8)} to ${found.slice(0, 8)} while it was being judged`);
    this.name = 'HeadMovedError';
  }
}

export function isHeadMoved(error: unknown): error is HeadMovedError {
  return error instanceof HeadMovedError || (error instanceof Error && error.name === 'HeadMovedError');
}
