#!/usr/bin/env bash
# Refresh snapshot.json with the author's PRs from the GitHub search API.
# The page falls back to this file when GitHub is rate-limited or unreachable.
# Optional: set GITHUB_TOKEN to raise the rate limit. jq is optional (used only for checks).
set -euo pipefail

REPO="Graphify-Labs/graphify"
AUTHOR="Deepjyoti-Sarmah"
URL="https://api.github.com/search/issues?q=repo:${REPO}+author:${AUTHOR}+is:pr&per_page=100&sort=created&order=desc"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/snapshot.json"
raw="$(mktemp)"
candidate="$(mktemp)"
trap 'rm -f "$raw" "$candidate"' EXIT

auth=()
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  auth=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi

curl -fsSL ${auth[@]+"${auth[@]}"} -H "Accept: application/vnd.github+json" "$URL" -o "$raw"

if command -v jq >/dev/null 2>&1; then
  jq -e '.items | type == "array"' "$raw" >/dev/null
  total="$(jq -r '.total_count' "$raw")"
  shown="$(jq -r '.items | length' "$raw")"
  if [[ "$total" != "$shown" ]]; then
    echo "warning: GitHub reports $total PRs but returned $shown; add paging before publishing" >&2
  fi
else
  grep -q '"items"' "$raw"
fi

# Wrap the raw search response with a fetch time, so the page can say how old the snapshot is.
fetched_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
  printf '{"fetched_at":"%s","repo":"%s","author":"%s","search":' "$fetched_at" "$REPO" "$AUTHOR"
  cat "$raw"
  printf '}\n'
} > "$candidate"

if command -v jq >/dev/null 2>&1; then
  jq empty "$candidate"
fi

mv "$candidate" "$out"
echo "wrote $out ($shown PRs, fetched $fetched_at)"
