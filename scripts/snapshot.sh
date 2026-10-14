#!/usr/bin/env bash
# Refresh snapshot.json with the author's PRs and issues from the GitHub search API.
# The page falls back to this file when GitHub is rate-limited or unreachable.
# Optional: set GITHUB_TOKEN to raise the rate limit. jq is optional (used only for checks).
set -euo pipefail

REPO="Graphify-Labs/graphify"
AUTHOR="Deepjyoti-Sarmah"
URL="https://api.github.com/search/issues?q=repo:${REPO}+author:${AUTHOR}+is:pr&per_page=100&sort=created&order=desc"
ISSUE_URL="https://api.github.com/search/issues?q=repo:${REPO}+author:${AUTHOR}+is:issue&per_page=100&sort=created&order=desc"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/snapshot.json"
raw="$(mktemp)"
raw_issue="$(mktemp)"
candidate="$(mktemp)"
trap 'rm -f "$raw" "$raw_issue" "$candidate"' EXIT

auth=()
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  auth=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi

curl -fsSL ${auth[@]+"${auth[@]}"} -H "Accept: application/vnd.github+json" "$URL" -o "$raw"
curl -fsSL ${auth[@]+"${auth[@]}"} -H "Accept: application/vnd.github+json" "$ISSUE_URL" -o "$raw_issue"

shown="?"
ishown="?"
if command -v jq >/dev/null 2>&1; then
  jq -e '.items | type == "array"' "$raw" >/dev/null
  jq -e '.items | type == "array"' "$raw_issue" >/dev/null
  total="$(jq -r '.total_count' "$raw")"
  shown="$(jq -r '.items | length' "$raw")"
  if [[ "$total" != "$shown" ]]; then
    echo "warning: GitHub reports $total PRs but returned $shown; add paging before publishing" >&2
  fi
  itotal="$(jq -r '.total_count' "$raw_issue")"
  ishown="$(jq -r '.items | length' "$raw_issue")"
  if [[ "$itotal" != "$ishown" ]]; then
    echo "warning: GitHub reports $itotal issues but returned $ishown; add paging before publishing" >&2
  fi
else
  grep -q '"items"' "$raw"
  grep -q '"items"' "$raw_issue"
fi

# Wrap the raw search responses with a fetch time, so the page can say how old the snapshot is.
# "search" stays the PR search so old page code keeps loading; "issue_search" is new.
fetched_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
  printf '{"fetched_at":"%s","repo":"%s","author":"%s","search":' "$fetched_at" "$REPO" "$AUTHOR"
  cat "$raw"
  printf ',"issue_search":'
  cat "$raw_issue"
  printf '}\n'
} > "$candidate"

if command -v jq >/dev/null 2>&1; then
  jq empty "$candidate"
fi

mv "$candidate" "$out"
echo "wrote $out ($shown PRs, $ishown issues, fetched $fetched_at)"
