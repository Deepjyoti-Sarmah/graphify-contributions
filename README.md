# Graphify contributions

A static page listing every pull request by Deepjyoti-Sarmah on
[Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify). Each PR shows
its write-up (why, what changed, how it helps, limits) next to live GitHub status.
A Proposals section lists ideas the maintainer can approve before any code is written.

There is no build step and no npm. The files are served as they are.

## Files

| File | Purpose |
|---|---|
| `index.html` | Loads the libraries, the Tailwind config and the styles, and mounts `#root`. |
| `app.js` | All React components, written with `htm` (no JSX). |
| `data.json` | Hand-written write-ups, the PR groups and the proposals. |
| `snapshot.json` | Fallback copy of the GitHub search result, used when GitHub is rate-limited or unreachable. |
| `scripts/snapshot.sh` | Refreshes `snapshot.json` with `curl`. |
| `.nojekyll` | Stops GitHub Pages from running Jekyll. |

## Editing data.json

- `groups`: each group has `id`, `title` (the issue title), `issue` (the issue number) and `prs` (PR numbers, in display order).
- `prs`: keyed by PR number as a string. Only PRs with an entry get a write-up. Every other PR shows its GitHub description and a "No write-up yet" badge.
  - `summary`: one plain sentence, shown on the card.
  - `why`, `what`, `helps`: short paragraphs.
  - `before`, `after`: short text or code showing the old and new behaviour.
  - `limits`, `tests`: lists. Tests are names only.
  - `cases` (optional): rows with `case`, `correct`, `before`, `after` and `covered_by`.
- `prs[n].landed` (optional): see "Landed PRs" below.
- `proposals`: an array (empty for now; the page shows "No proposals yet").
  - `id`, `title`, `problem`, `evidence` (text), `plan` (list of steps), `size` (text), `risk` (`low`, `medium` or `high`), `related` (issue or PR numbers).

Write only facts you can point to. The page shows the text as given.

## Landed PRs

Use `landed` when the maintainer applied a PR's commits by hand and closed the PR without merging it.
GitHub then shows the PR as closed, which would wrongly suggest it was rejected.

```json
"4326": {
  "landed": {
    "commits": ["f905db7", "f5300d5"],
    "note": "Applied to v8 by the maintainer, authorship kept."
  }
}
```

- `commits`: short or full SHAs from the repository. Each one links to `https://github.com/Graphify-Labs/graphify/commit/<sha>`.
- `note`: one sentence on what the maintainer did.
- The entry may hold only `landed`. The PR then keeps its GitHub description and shows the "No write-up yet" badge.

Status is decided in this order:

1. Open, or draft: as GitHub reports it.
2. `merged_at` is set: **Merged**.
3. Closed, and the entry has `landed`: **Landed**.
4. Otherwise: **Closed**.

Landed counts as a success. It shares the violet colour and the "Merged / landed" count and filter with merged PRs, and it has its own icon (◆) and label.
Do not add `landed` to a PR that GitHub shows as merged; the merge takes precedence.

## Refreshing the snapshot

```bash
./scripts/snapshot.sh
```

It needs `curl`. `jq` is optional and adds a check that the search did not return a partial page.
Set `GITHUB_TOKEN` to raise GitHub's rate limit (60 requests per hour unauthenticated).
Commit the new `snapshot.json` to update the fallback.

## Running locally

```bash
cd graphify-contributions
python3 -m http.server 8000
```

Then open http://localhost:8000.

To test the snapshot fallback, add this line to `index.html` just before `<script src="app.js">`,
load the page, then remove the line:

```html
<script>window.CONTRIB_API_BASE = 'https://invalid.invalid';</script>
```

The page will then show the banner "Showing snapshot from <date> (GitHub unreachable)".

## Caching

Search results and per-PR CI status are cached in `localStorage` for 10 minutes.
Every `localStorage` call is wrapped in `try/catch`, so the page still works when storage is blocked.
The Refresh button skips the cache.

## Deploying to GitHub Pages

1. Push this folder to a repository.
2. In the repository settings, open **Pages**, choose **Deploy from a branch**, and select the branch and the `/` (root) folder.
3. Wait for the Pages build, then open the URL it shows.

`.nojekyll` must stay in the root so Pages serves the files unchanged.
