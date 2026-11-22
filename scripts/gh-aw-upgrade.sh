#!/usr/bin/env bash
# gh-aw-upgrade — runbook steps 1–3 of runbooks/operations/model-catalog-refresh.md, as one
# command: pick a gh-aw release, recompile the three agentic workflows with it, put back what a
# recompile drops, and refuse to call the result good unless the pricing catalog it pins
# actually prices the models this product needs.
#
# WHY IT EXISTS (PB-021, 2026-11-22, GHI #410/#411). The catalog (`models.json`) is pinned
# into the compiled locks; the threat-detection judge's model is an alias that floats with the
# provider. A new Haiku release therefore broke every agentic run on a target with no change on
# our side, and the only way anyone found out was a paid dispatch and a job log. The fix has
# always been "upgrade, recompile, reinstall"; this makes the first two steps repeatable, and
# `.github/workflows/gh-aw-upgrade.yml` runs it on demand and opens the pull request.
#
# Needs: Node 24, `npm ci` already run, and `gh` authenticated. It checks the first two before
# touching anything.
#
# It changes the working tree and NOTHING ELSE: no commit, no push, no pull request, no write to
# any target repository, and no change to the `gh` extensions on the machine it runs on (the
# compiler is downloaded to a temporary directory and run from there).
#
# Exit codes:  0 recompiled and every required model is priced
#              2 usage, or a release this script refuses (prerelease without --allow-prerelease)
#              3 recompiled, but a required model is NOT priced — the runbook's stop condition:
#                the release has not caught up; do not merge, do not reinstall
#              1 anything else (download, checksum, compile, enforce)
set -euo pipefail

VERSION=latest
ALLOW_PRERELEASE=false
REQUIRE="claude-sonnet-5 claude-haiku-5-5"
WORKFLOWS=(plan-propose plan-revise build-template)

usage() {
  cat >&2 <<'EOF'
usage: scripts/gh-aw-upgrade.sh [--version vX.Y.Z|latest] [--allow-prerelease] [--require "<model> <model>…"]

  --version           gh-aw release to compile with (default: latest, the newest STABLE release)
  --allow-prerelease  accept a release GitHub marks prerelease (see GHI #285 before using this)
  --require           model ids the pinned catalog must price, space-separated
                      (default: "claude-sonnet-5 claude-haiku-5-5")
EOF
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 || usage ;;
    --allow-prerelease) ALLOW_PRERELEASE=true; shift ;;
    --require) REQUIRE="${2:-}"; shift 2 || usage ;;
    *) usage ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

# ── 0. what this needs from the checkout, asked BEFORE anything is changed ───────────────────
# Both of these used to surface after the compile, as a stack trace from lock:enforce, leaving
# recompiled locks with no job timeouts in the tree. Checked here, the tree is still untouched.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 24 ]; then
  printf '%s\n' "needs Node 24 or later (found: $(node --version 2>/dev/null || echo none)) — \`npm run lock:enforce\` does not run on older Node" >&2
  exit 2
fi
if [ ! -x node_modules/.bin/tsx ]; then
  printf '%s\n' "dependencies are not installed here: run \`npm ci\` first (\`npm run lock:enforce\` runs from them). Nothing was changed." >&2
  exit 2
fi
say() { printf '%s\n' "$*"; }
# The report goes to the terminal, to the Actions step summary when there is one, and to
# $GH_AW_UPGRADE_REPORT when the caller wants it as a file (the workflow uses it as the PR body).
note() {
  say "$*"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then say "$*" >> "$GITHUB_STEP_SUMMARY"; fi
  if [ -n "${GH_AW_UPGRADE_REPORT:-}" ]; then say "$*" >> "$GH_AW_UPGRADE_REPORT"; fi
}

# ── 1. which release ────────────────────────────────────────────────────────────────────────
# `releases/latest` is GitHub's own "newest non-prerelease", which is the channel rule #285
# asks for. A version typed by hand is checked against the same flag rather than trusted.
if [ "$VERSION" = latest ]; then
  VERSION="$(gh api repos/github/gh-aw/releases/latest --jq .tag_name)"
fi
if ! printf '%s' "$VERSION" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  say "not a gh-aw release tag: '$VERSION' (expected vX.Y.Z)" >&2; exit 2
fi
PRERELEASE="$(gh api "repos/github/gh-aw/releases/tags/$VERSION" --jq .prerelease)"
if [ "$PRERELEASE" = true ] && [ "$ALLOW_PRERELEASE" != true ]; then
  say "gh-aw $VERSION is a PRERELEASE. Refusing without --allow-prerelease (GHI #285 is why)." >&2
  exit 2
fi

OLD_PIN="$(grep -oE 'gh-aw-actions/setup@[a-f0-9]{40} # v[0-9.]+' templates/workflows/plan-propose.lock.yml | head -1 | sed 's/.*# //')"

# ── 2. the compiler, downloaded and checked, never installed ────────────────────────────────
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ASSET=linux-amd64 ;;
  Linux-aarch64 | Linux-arm64) ASSET=linux-arm64 ;;
  Darwin-x86_64) ASSET=darwin-amd64 ;;
  Darwin-arm64) ASSET=darwin-arm64 ;;
  *) say "no gh-aw release asset known for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
TOOLS="$(mktemp -d)"
# gh-aw owns the lock line in .gitattributes and rewrites it on every compile, without the
# `merge=ours` this repo added on purpose. Put the file back exactly as it was FOUND — not as it
# is committed: `git checkout -- .gitattributes` would also throw away an edit somebody had not
# committed yet (Codex on PR #413). On EXIT, so a compile that fails halfway restores it too.
cp .gitattributes "$TOOLS/gitattributes.before"
cleanup() {
  if [ -f "$TOOLS/gitattributes.before" ]; then cp "$TOOLS/gitattributes.before" .gitattributes; fi
  rm -rf "$TOOLS"
}
trap cleanup EXIT
BASE="https://github.com/github/gh-aw/releases/download/$VERSION"
curl -sSfL --retry 3 -o "$TOOLS/gh-aw" "$BASE/$ASSET"
curl -sSfL --retry 3 -o "$TOOLS/checksums.txt" "$BASE/checksums.txt"
# The checksum file comes from the same release as the binary, so this proves the download is
# intact, not who built it — gh-aw publishes no build attestation to check (verified 2026-11-22).
WANT="$(awk -v a="$ASSET" '$2 == a { print $1 }' "$TOOLS/checksums.txt")"
if [ -z "$WANT" ]; then say "checksums.txt for $VERSION has no entry for $ASSET" >&2; exit 1; fi
if command -v sha256sum >/dev/null 2>&1; then
  GOT="$(sha256sum "$TOOLS/gh-aw" | awk '{ print $1 }')"
else
  GOT="$(shasum -a 256 "$TOOLS/gh-aw" | awk '{ print $1 }')"
fi
if [ "$WANT" != "$GOT" ]; then say "checksum mismatch for $ASSET: want $WANT, got $GOT" >&2; exit 1; fi
chmod +x "$TOOLS/gh-aw"
say "compiler: $("$TOOLS/gh-aw" version)  (was pinned: ${OLD_PIN:-unknown})"

# ── 3. recompile, then put back what a recompile drops ──────────────────────────────────────
# The compiler resolves action pins through the GitHub API, so it needs a token like any `gh`
# call. One workflow at a time: a failure names the file it belongs to.
export GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-$(gh auth token)}}"
for w in "${WORKFLOWS[@]}"; do
  "$TOOLS/gh-aw" compile "templates/workflows/$w.md" --no-check-update
done
# Job-level timeouts and the upload cap have no frontmatter knob and do not survive a compile.
npm run --silent lock:enforce
# .gitattributes: restored to what this run found (see the trap above). Every compile, not just
# big version jumps. Done here as well as on EXIT so the report below lists the right files.
cp "$TOOLS/gitattributes.before" .gitattributes

# ── 4. does the catalog these locks pin price what we run? ──────────────────────────────────
SHAS="$(grep -ohE 'gh-aw-actions/setup@[a-f0-9]{40}' templates/workflows/*.lock.yml | sort -u | cut -d@ -f2)"
if [ "$(printf '%s\n' "$SHAS" | grep -c .)" != 1 ]; then
  say "the three locks do not pin ONE gh-aw-actions/setup commit:" >&2; say "$SHAS" >&2; exit 1
fi
SHA="$SHAS"
curl -sSfL --retry 3 -o "$TOOLS/models.json" \
  "https://raw.githubusercontent.com/github/gh-aw-actions/$SHA/setup/js/models.json"
PRICED="$(grep -oE '"claude-[a-z0-9.-]+"' "$TOOLS/models.json" | tr -d '"' | sort -u)"
if [ -z "$PRICED" ]; then
  say "could not read any Claude model out of the catalog at gh-aw-actions@$SHA — its layout may have moved; check by hand before trusting this upgrade" >&2
  exit 1
fi

note "## gh-aw upgrade: ${OLD_PIN:-unknown} → $VERSION"
note ""
note "- Compiler release: \`$VERSION\` (prerelease: $PRERELEASE)"
note "- Catalog pinned by the recompiled locks: \`gh-aw-actions/setup@$SHA\`"
note ""
note "| Required model | Priced by the pinned catalog? |"
note "|---|---|"
MISSING=0
for m in $REQUIRE; do
  if printf '%s\n' "$PRICED" | grep -qxF "$m"; then
    note "| \`$m\` | yes |"
  else
    note "| \`$m\` | **NO** |"
    MISSING=1
  fi
done
note ""
note "<details><summary>Every Claude model the pinned catalog prices</summary>"
note ""
note "$(printf '%s\n' "$PRICED" | sed 's/^/- /')"
note ""
note "</details>"
note ""
note "Files changed:"
note ""
note "$(git status --short | sed 's/^/    /')"

if [ "$MISSING" = 1 ]; then
  note ""
  note "**Stop: this release does not price every required model.** Do not merge or reinstall; retry on a later release."
  exit 3
fi
