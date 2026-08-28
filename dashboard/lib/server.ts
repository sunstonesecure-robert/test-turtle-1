import { createClient, type RepoRef } from './github/client';
import type { Octokit } from '@octokit/rest';

/**
 * Server-side GitHub access for pages and server actions. Tokens never reach
 * the browser: pages are server components and writes go through server
 * actions, both running with this module's client (GitOps-Native, SC-003 —
 * the approval merge itself is a deep-link the operator performs as themselves).
 */
export function github(): { gh: Octokit; repo: RepoRef } {
  const owner = process.env.OWNER ?? '';
  const repo = process.env.REPO ?? '';
  if (!owner || !repo) throw new Error('Set OWNER and REPO in dashboard/.env.local');
  return { gh: createClient(), repo: { owner, repo } };
}

export function operatorLogin(): string {
  return process.env.OPERATOR_LOGIN ?? 'operator';
}

/**
 * Where the confirmation guides live — ONE central copy, pointed at by configuration
 * (operator decision, 2026-08-27, GHI #88).
 *
 * The panel used to link `skills/<authority>-confirmation/SKILL.md` inside the TARGET
 * repository, and `scripts/install.ts` never vendors `skills/` into a target — so the
 * button 404'd on every governed repo. It is the only in-product route from "this build
 * is blocked pending an outside expert" to "here is how to get that answer", and it led
 * nowhere.
 *
 * Vendoring a copy into each target was the alternative and was rejected: the guides
 * are prose that changes (they changed on 2026-08-27 to teach the decision ledger), and
 * a copy per target is a copy per target to keep current — an operator following a stale
 * guide would be told to write a record whose shape the gate no longer accepts. One
 * copy, configurable, so a deployment can point at its own fork or its own docs site.
 */
const DEFAULT_CONFIRMATION_GUIDE_BASE = 'https://github.com/SunStone-Secure-LLC/agentic-turtles/blob/HEAD/skills';

/**
 * The configured base, or the default. Takes the raw value as an argument — defaulted
 * from the environment — so the resolution is testable without mutating process.env.
 *
 * AN INVALID VALUE FALLS BACK RATHER THAN THROWING. The failure being fixed here is a
 * dead link; throwing would take the whole Andon review page down for a typo in a URL,
 * which is worse than the thing it replaces — an operator would lose the ability to
 * review anything, not merely to follow one link. The rejection is logged with the
 * variable named, and the documented behaviour is in CONFIGURATION_GUIDE.md §1.
 *
 * Only http(s) is accepted. The value is rendered as an `href`, so a `javascript:` or
 * `data:` URL would be a script-injection vector handed to whoever sets the environment.
 */
export function confirmationGuideBase(configured: string | undefined = process.env.CONFIRMATION_GUIDE_BASE_URL): string {
  const raw = configured?.trim();
  if (!raw) return DEFAULT_CONFIRMATION_GUIDE_BASE;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    console.warn(`CONFIRMATION_GUIDE_BASE_URL is not a URL (${raw}) — falling back to ${DEFAULT_CONFIRMATION_GUIDE_BASE}`);
    return DEFAULT_CONFIRMATION_GUIDE_BASE;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    console.warn(
      `CONFIRMATION_GUIDE_BASE_URL must be http(s) (got ${parsed.protocol}) — falling back to ${DEFAULT_CONFIRMATION_GUIDE_BASE}`,
    );
    return DEFAULT_CONFIRMATION_GUIDE_BASE;
  }
  // Trailing slashes are normalized away so the join below produces one separator
  // whether or not the operator typed one — a `//` in the path 404s on some hosts and
  // silently redirects on others, and neither is worth leaving to chance.
  return raw.replace(/\/+$/, '');
}

/** The guide for one authority's confirmation skill. */
export function confirmationGuideUrl(skill: string, configured?: string): string {
  return `${confirmationGuideBase(configured)}/${skill}/SKILL.md`;
}
