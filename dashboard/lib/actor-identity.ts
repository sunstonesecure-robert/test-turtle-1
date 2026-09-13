/**
 * The two logins this product writes when it has no identity to record. NEITHER is
 * a person, and BOTH are live github.com namespaces — github.com/operator is an
 * Organization (id 5439973) and github.com/unknown a User (id 44306450) — so a
 * record carrying one must not be linked as a profile OR rendered as a handle.
 *
 * THE GUARD IS HERE, NOT IN `userUrl`. `PLAIN_LOGIN` in lib/github/urls.ts answers
 * "is this string a GitHub profile path" — a fact about GitHub's grammar, true of
 * both of these and permanently so. "Is this one of the two values this product
 * writes when it had no identity" is a fact about PROVENANCE: the string came out
 * of `operatorLogin()` or out of `getApprovalRecord`'s `??` fallback, and a URL
 * helper cannot see where its argument came from. Matching the strings is safe at
 * the app layer, where the whole population is `WorkloadEvent.by`,
 * `intentConfirmation.by` and `ArchivedApproval.approver`; it would not be safe
 * inside a helper whose population is every login the product will ever hand it.
 *
 * Deliberate false negative: the real accounts literally named `operator` and
 * `unknown` would be described here as unidentified. That is the safe direction —
 * under-naming a real actor beats naming an unrelated one — and neither could
 * plausibly be the operator of, or the merger of an approval in, a governed repo.
 *
 * A leaf module with no imports on purpose: it is read from server components, from
 * the browser bundle, and from a module that `scripts/gates/post-merge-freeze.ts`
 * pulls in, and none of those should acquire a dependency to ask this question.
 */
export const OPERATOR_PLACEHOLDER_LOGIN = 'operator';
export const UNREPORTED_APPROVER_LOGIN = 'unknown';

export interface UnnamedActor {
  /** What the surface says instead of a handle — deliberately not @-prefixed. */
  text: string;
  /** Why this names nobody, and the remedy where there is one. */
  title: string;
}

/**
 * The record names nobody, and WHICH nobody it is — or null when the login is a
 * real actor (a person, or an App such as `github-actions[bot]`).
 *
 * Two distinct strings deliberately. "An unidentified operator" is FALSE for the
 * approver case: that is not an unset environment variable, it is GitHub not
 * reporting who merged, and the remedy differs — there is none, and the record is
 * complete without it. One shared sentence would be wrong on one of the two.
 *
 * Case-insensitive: GitHub logins are case-insensitively unique, which is the same
 * rule lib/github/answers.ts already applies when it matches a marker's `by` to a
 * comment's author.
 */
export function unnamedActor(login: string): UnnamedActor | null {
  switch (login.toLowerCase()) {
    case OPERATOR_PLACEHOLDER_LOGIN:
      return {
        text: 'an unidentified operator',
        title:
          'No GitHub login was recorded for this action — the dashboard was running without OPERATOR_LOGIN set, so this names nobody. Set OPERATOR_LOGIN so later records name a person.',
      };
    case UNREPORTED_APPROVER_LOGIN:
      return {
        text: 'an unidentified approver',
        title:
          'GitHub did not report who merged this approval, so this record names nobody. The merge itself, its timestamp and the frozen version are still on record.',
      };
    default:
      return null;
  }
}

/**
 * A LOGIN THE PRODUCT WRITES INTO CONTENT GITHUB RENDERS — spelled so GitHub
 * cannot turn it into a live mention (GHI #245).
 *
 * WHAT GITHUB DOES WITH A BARE AT-SIGN, verified against its own renderer rather
 * than assumed. POST /markdown (mode `gfm`) on "by @operator" returns
 * `<a class="user-mention" data-hovercard-type="organization" href="https://github.com/operator">`
 * — a real link to a real namespace. `@unknown` comes back as `data-hovercard-type="user"`,
 * a private individual, and a user mention in an issue comment NOTIFIES them.
 * That pipeline is every surface this product writes prose into: issue bodies,
 * issue and pull-request comments, and check-run output. The at-sign linkifies
 * wherever it sits at a word boundary — `by @login`, `(@login)` and `by:@login`
 * all came back as anchors — so "that word is obviously a placeholder" is not a
 * safety argument. GitHub linkifies only accounts that EXIST, and the product
 * cannot know which words are accounts: `@actor` and `@approver` both resolve.
 *
 * WHY INERT ALWAYS, RATHER THAN CHECKING MEMBERSHIP FIRST. The operator's rule
 * permits mentioning their own org's members and this repo's collaborators — but
 * permission is not a requirement. Asking "is this login a collaborator" costs a
 * GitHub read on every write, adds a failure mode to a write path whose whole job
 * is to leave a durable record, and is stale the instant access changes: the
 * record is permanent (nothing is ever deleted) and the membership that justified
 * it is not. Set against that, the notification buys nothing — it tells the
 * operator about an action they just performed themselves. Rendering every login
 * inertly satisfies the prohibition absolutely, at zero read cost, with no failure
 * mode and no correctness window. So there is no membership branch here, and a
 * future reader should not add one.
 *
 * THE HTML-COMMENT MARKERS ARE EXEMPT, AND DELIBERATELY UNCHANGED. Rendering the
 * dual-half comment body proved it: the `<!-- workload-event:v1 … by:@login … -->`
 * half produced ZERO output — stripped entirely, not even a comment node. Nothing
 * invisible can raise a mention, so the markers are already safe, while their
 * exact `by:@<login>` shape is load-bearing for the regexes that parse them and
 * for the anti-forgery check that compares a marker's `by` to its comment author.
 * Making those inert would break every reader for no safety gain. See the note at
 * each marker serializer.
 *
 * TWO FUNCTIONS BECAUSE GITHUB HAS TWO RENDERERS, not as a style choice:
 *  - `inertLogin` is for markdown surfaces, where a code span is proven inert
 *    (`` `@operator` `` rendered as a plain `<code>`, no anchor, no hovercard) and
 *    keeps the at-sign legible to a human reading the record.
 *  - `plainLogin` is for everything else — commit messages, annotated tag messages,
 *    and values stored as data that get re-rendered somewhere unknown later. Those
 *    are not GFM; GitHub runs a narrower autolink filter over them that does not
 *    process code spans, so backticks there are decoration, not protection. The
 *    at-sign is what triggers linkification, so the at-sign is what goes.
 *
 * Both branch on `unnamedActor` first, so a record that names nobody says so in
 * prose instead of printing a handle for a stranger — the same answer `ActorLogin`
 * gives on screen, now given to the permanent written record too.
 *
 * NEITHER MAY ASSUME ITS ARGUMENT IS A WELL-FORMED LOGIN, and that is the whole
 * reason `neutralize` exists below rather than these two just wrapping the string.
 */
function neutralize(login: string): string {
  return login.replace(/[`@]+/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * THE VALUE IS NOT TRUSTED TO BE A LOGIN, so the rendering is not trusted to
 * contain it. Wrapping alone is escapable, and both escapes are real:
 *
 *  - A BACKTICK IN THE VALUE CLOSES THE CODE SPAN. Verified against GitHub's own
 *    renderer: `` `@x` @rficcaglia` `` came back as `<code>@x</code>` followed by a
 *    live `user-mention` anchor for a personal account. Everything after the stray
 *    backtick is markdown again, so the fence protects only the first fragment.
 *  - AN AT-SIGN IN THE VALUE SURVIVES `plainLogin`. It drops the at-sign this
 *    product writes; one carried inside the value is passed straight through, and
 *    "by bot @rficcaglia" rendered as a live mention.
 *
 * AND THE VALUES REALLY CAN CARRY THEM. `operatorLogin()` is `process.env.OPERATOR_LOGIN`
 * with no validation anywhere. Every marker regex captures the login as `\S+`, and a
 * hand-edited marker is a first-class flow here, not an attack — the GitHub UI is a
 * supported way to work. And the lifecycle workflow resolves its actor from
 * `client_payload.by`, which is arbitrary JSON on a repository dispatch. A helper
 * whose safety depends on its caller having passed a tidy `[A-Za-z0-9-]+` is not the
 * absolute guarantee this module claims to make.
 *
 * So the two characters that can defeat either rendering come out of the value
 * first, and runs of whitespace collapse — a blank line inside the value ends the
 * span as surely as a backtick does. What is left cannot linkify in any surface:
 * an at-sign is the only thing GitHub linkifies on, and after this there is exactly
 * one at-sign in the result, the one `inertLogin` writes inside its own fence.
 *
 * Degrading the value rather than refusing it is deliberate: these run on write
 * paths whose entire job is to leave a durable record, and a record that spells a
 * malformed actor slightly wrong beats no record at all — or a mention. The edge
 * of that, stated rather than hidden: a value made of nothing BUT those characters
 * neutralizes to empty, and the record then names nobody. No prose is invented for
 * it — the two "unidentified" sentences above are about two specific, known causes,
 * and borrowing one here would assert a reason this module cannot know.
 */
export function inertLogin(login: string): string {
  const unnamed = unnamedActor(login);
  // A code span, not the raw handle: proven non-linkifying, and the at-sign
  // survives for the human reading the timeline.
  return unnamed ? unnamed.text : `\`@${neutralize(login)}\``;
}

/**
 * The same policy for a surface with no markdown renderer — see `inertLogin`.
 *
 * Drops the at-sign rather than fencing it, because a commit or tag message is
 * not GFM and a code span would render as literal backticks while the mention
 * still linkified in the web UI. A bare login never linkifies anywhere, so this
 * is the universally safe spelling; it is also the right one for a value written
 * into a data field, where the eventual renderer is unknown at the point of write.
 *
 * Same `neutralize` for the same reason: an at-sign this function did not write is
 * still an at-sign GitHub will linkify.
 */
export function plainLogin(login: string): string {
  const unnamed = unnamedActor(login);
  return unnamed ? unnamed.text : neutralize(login);
}
