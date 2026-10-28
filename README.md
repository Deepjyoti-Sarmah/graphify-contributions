# Graphify contributions

A static page listing every pull request by Deepjyoti-Sarmah on
[Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify). Each PR shows
its write-up (why, what changed, how it helps, limits) next to live GitHub status.
An "Issues I raised" section lists bugs found while using Graphify, with live state and the pull requests that fix them.
A Proposals section lists ideas the maintainer can approve before any code is written.

There is no build step and no npm. The files are served as they are.

## Files

| File | Purpose |
|---|---|
| `index.html` | Loads the libraries, the Tailwind config and the styles, and mounts `#root`. |
| `app.js` | All React components, written with `htm` (no JSX). |
| `data.json` | Hand-written write-ups, the PR groups and the proposals. |
| `snapshot.json` | Fallback copies of the GitHub PR and issue search results, used when GitHub is rate-limited or unreachable. |
| `scripts/snapshot.sh` | Refreshes `snapshot.json` with `curl`. |
| `scripts/check-diagrams.sh` | Renders every Mermaid source in `data.json` in headless Chrome and fails on the ones that do not render, using the Mermaid build `index.html` loads. |
| `.nojekyll` | Stops GitHub Pages from running Jekyll. |

## Editing data.json

- `groups`: each group has `id`, `title` (the issue title), `issue` (the issue number) and `prs` (PR numbers, in display order). `reported_by` (optional) is the GitHub login of the person who raised the issue, shown next to the issue number. Set it for every group whose issue the author did not raise. A group without it means the author raised the issue, so the two lists agree.
  - `fixed_by` (optional): PR numbers whose card is shown under another group, because one PR fixed two issues. They render as a compact "Fixed by #..." line under the title, so the same card is not shown twice. A group with no `prs` but a `fixed_by` still appears.
  - A write-up whose PR is in no group appears under a final "Other pull requests" heading, so give every PR a group when one exists.
- `prs`: keyed by PR number as a string. Only PRs with an entry get a write-up. Every other PR shows its GitHub description and a "No write-up yet" badge.
  - `summary`: one plain sentence, shown on the card.
  - `why`, `what`, `helps`: short paragraphs.
  - `before`, `after`: short text or code showing the old and new behaviour.
  - `limits`, `tests`: lists. Tests are names only.
  - `diagram` (optional): a Mermaid source string (for example `flowchart TD\n  A --> B`). Shown first in the expanded card, in a box that scrolls sideways. It is rendered in the browser by Mermaid 10.9.1 with `securityLevel: 'strict'`, in the page theme. If the source does not parse, the page shows "Diagram could not be rendered" above the raw source, so fix the syntax (try it at https://mermaid.live) and reload.
  - `sequence` (optional): a second Mermaid source string for a sequence diagram (for example `sequenceDiagram\n  A->>B: call`). Shown under the flow diagram, same box and same failure behaviour. Mermaid renders it with `sequence` layout options, so it reads as a numbered call flow.
  - `cases` (optional): rows with `case`, `correct`, `before` (v8), `pr_first_version` (the first version of the PR, shown as "PR before"), `after` (this PR, shown as "PR now") and `covered_by`. Below `sm` (640px) each case is a stacked card; at `sm` and wider it is a table.
- `prs[n].landed` (optional): see "Landed PRs" below.
- `issues`: an array in display order. Each entry has `number`, one plain sentence `summary` on what goes wrong, and `fixed_by` (PR numbers, shown with the live state the page already knows). `title` is optional and is used only when the issue is missing from both the live search and the snapshot, so the card never shows a bare number. The issue title and its open or closed state always come from GitHub when available. Only issues the author raised belong here, because the heading claims authorship. The list is `curl -fsSL 'https://api.github.com/search/issues?q=repo:Graphify-Labs/graphify+author:Deepjyoti-Sarmah+is:issue&per_page=100'`. An issue someone else raised stays in its `groups` entry with `reported_by` set.
- `proposals`: an array. The page shows "No proposals yet" when it is empty.
  - `id`, `title`, `problem`, `evidence` (text), `status` (shown as a tag), `plan` (list of steps), `size` (text), `risk` (`low`, `medium` or `high`), `related` (issue or PR numbers), `diagram` (optional, same Mermaid source string as for PRs; shown after the parts, same failure behaviour).
  - `parts` (optional): ordered sections rendered above the plan. Each has `label`, `md` (GitHub-flavoured Markdown, including tables), and optional `diagram` and `caption`.

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
The file holds `search` (the PR search, unchanged so old page code keeps loading) and `issue_search` (the issue search).
A snapshot without `issue_search` still loads; the issues then render without state badges.

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

## Checking the diagrams

```bash
./scripts/check-diagrams.sh
```

It serves the folder, renders every `diagram` and `sequence` in `data.json` with the
Mermaid build `index.html` names, and prints one line per source. One that does not
render fails the run, so a card never ships with "Diagram could not be rendered" above
its raw source.

Two things break a sequence diagram quietly: a semicolon inside a message ends the
statement, and so does an unbalanced `alt` block. Use a comma instead of a semicolon.

The script needs `python3` and a headless Chrome (`chromium`, `google-chrome`, or a
puppeteer download). Set `CHROME=/path/to/chrome` when it is somewhere else. Mermaid
itself comes from the CDN, so the check needs network access; it exits 2 when the
browser cannot reach it.

## Caching

Search results and per-PR CI status are cached in `localStorage` for 10 minutes.
Every `localStorage` call is wrapped in `try/catch`, so the page still works when storage is blocked.
The Refresh button skips the cache.

## Deploying to GitHub Pages

1. Push this folder to a repository.
2. In the repository settings, open **Pages**, choose **Deploy from a branch**, and select the branch and the `/` (root) folder.
3. Wait for the Pages build, then open the URL it shows.

`.nojekyll` must stay in the root so Pages serves the files unchanged.
