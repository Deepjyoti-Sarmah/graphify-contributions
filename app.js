/* Graphify contributions page. React + htm, no JSX and no build step.
   Every "why", "what" and "limits" line comes from data.json; GitHub supplies the rest. */
const { useState, useEffect, useMemo, useCallback } = React;
const html = htm.bind(React.createElement);

const REPO = 'Graphify-Labs/graphify';
const AUTHOR = 'Deepjyoti-Sarmah';
const API_BASE = window.CONTRIB_API_BASE || 'https://api.github.com';
const SEARCH_PATH = `/search/issues?q=repo:${REPO}+author:${AUTHOR}+is:pr&per_page=100&sort=created&order=desc`;
const CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_KEY = 'contrib:search:v1';
const THEME_KEY = 'contrib:theme';
const STATUSES = ['open', 'draft', 'merged', 'closed'];
const STATUS_ORDER = { open: 0, draft: 1, merged: 2, landed: 2, closed: 3 };
const COMMIT_URL = (sha) => `https://github.com/${REPO}/commit/${sha}`;
const ANSWERS = [
  { label: 'Go ahead', emoji: '👍' },
  { label: 'Discuss', emoji: '💬' },
  { label: 'Not now', emoji: '👎' },
];

const STATUS_META = {
  open: { label: 'Open', icon: '○', tone: 'bg-emerald-50 text-emerald-800 ring-emerald-600/30 dark:bg-emerald-950/60 dark:text-emerald-300 dark:ring-emerald-500/40' },
  merged: { label: 'Merged', filterLabel: 'Merged / landed', icon: '✓', tone: 'bg-violet-50 text-violet-800 ring-violet-600/30 dark:bg-violet-950/60 dark:text-violet-300 dark:ring-violet-500/40' },
  landed: { label: 'Landed', icon: '◆', tone: 'bg-violet-50 text-violet-800 ring-violet-600/30 dark:bg-violet-950/60 dark:text-violet-300 dark:ring-violet-500/40' },
  draft: { label: 'Draft', icon: '✎', tone: 'bg-slate-100 text-slate-700 ring-slate-500/30 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-500/40' },
  closed: { label: 'Closed', icon: '✕', tone: 'bg-red-50 text-red-800 ring-red-600/30 dark:bg-red-950/60 dark:text-red-300 dark:ring-red-500/40' },
};

const CI_META = {
  loading: { label: 'checking', icon: '…', tone: 'text-slate-500 dark:text-slate-400' },
  passing: { label: 'passing', icon: '✓', tone: 'text-emerald-700 dark:text-emerald-400' },
  failing: { label: 'failing', icon: '✕', tone: 'text-red-700 dark:text-red-400' },
  pending: { label: 'pending', icon: '◷', tone: 'text-amber-700 dark:text-amber-400' },
  unknown: { label: 'unknown', icon: '?', tone: 'text-slate-600 dark:text-slate-400' },
};

const RISK_TONE = {
  low: 'bg-emerald-50 text-emerald-800 ring-emerald-600/30 dark:bg-emerald-950/60 dark:text-emerald-300',
  medium: 'bg-amber-50 text-amber-800 ring-amber-600/30 dark:bg-amber-950/60 dark:text-amber-300',
  high: 'bg-red-50 text-red-800 ring-red-600/30 dark:bg-red-950/60 dark:text-red-300',
};

const BUTTON = 'pressable inline-flex items-center gap-1.5 whitespace-nowrap rounded-[10px] border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800';
const INPUT = 'w-full rounded-[10px] border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 transition-colors duration-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100';
const LABEL_HEAD = 'text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500 dark:text-slate-400';

// Every localStorage call goes through here, so blocked or full storage never breaks the page.
const storage = {
  read(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  },
  write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* no cache available */ }
  },
};

const freshCache = (key) => {
  const entry = storage.read(key);
  return entry && Date.now() - entry.t < CACHE_TTL_MS ? entry : null;
};

if (window.DOMPurify) {
  // Links inside PR descriptions open in a new tab and cannot reach back into this page.
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

const renderMarkdown = (text) => DOMPurify.sanitize(marked.parse(text || ''));

class GitHubError extends Error {
  constructor(message, rateLimited) {
    super(message);
    this.rateLimited = rateLimited;
  }
}

async function github(path) {
  let res;
  try {
    res = await fetch(API_BASE + path);
  } catch (e) {
    throw new GitHubError('network error', false);
  }
  const limited = res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
  if (limited) throw new GitHubError('rate limit', true);
  if (!res.ok) throw new GitHubError(`HTTP ${res.status}`, false);
  return res.json();
}

async function loadSnapshot() {
  const res = await fetch('snapshot.json');
  if (!res.ok) throw new Error('snapshot.json not found');
  return res.json();
}

// Live search first (cached for 10 minutes). On any failure, show the committed snapshot.
async function loadPullRequests(force) {
  if (!force) {
    const hit = freshCache(SEARCH_CACHE_KEY);
    if (hit) return { items: hit.data, source: 'live', at: hit.t };
  }
  try {
    const data = await github(SEARCH_PATH);
    const at = Date.now();
    storage.write(SEARCH_CACHE_KEY, { t: at, data: data.items });
    return { items: data.items, source: 'live', at };
  } catch (err) {
    const snap = await loadSnapshot();
    return {
      items: snap.search.items,
      source: 'snapshot',
      at: Date.parse(snap.fetched_at),
      reason: err.rateLimited ? 'GitHub rate limit' : 'GitHub unreachable',
    };
  }
}

// Checks load only when a card is expanded. The head SHA comes from the pull, then the check runs for that SHA.
function ciState(runs) {
  const FAILING = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'];
  const PASSING = ['success', 'neutral', 'skipped'];
  if (!runs.length) return 'unknown';
  if (runs.some((r) => r.status === 'completed' && FAILING.includes(r.conclusion))) return 'failing';
  if (runs.some((r) => r.status !== 'completed')) return 'pending';
  if (runs.every((r) => PASSING.includes(r.conclusion))) return 'passing';
  return 'unknown';
}

async function loadCI(number) {
  const key = `contrib:ci:v1:${number}`;
  const hit = freshCache(key);
  if (hit) return hit.data;
  const pull = await github(`/repos/${REPO}/pulls/${number}`);
  const runs = await github(`/repos/${REPO}/commits/${pull.head.sha}/check-runs?per_page=100`);
  const verdict = { state: ciState(runs.check_runs) };
  storage.write(key, { t: Date.now(), data: verdict });
  return verdict;
}

function normalize(item) {
  return {
    number: item.number,
    title: (item.title || '').trim(),
    body: item.body || '',
    state: item.state,
    draft: Boolean(item.draft),
    merged: Boolean(item.pull_request && item.pull_request.merged_at),
    created_at: item.created_at,
    labels: (item.labels || []).map((l) => l.name),
    comments: item.comments || 0,
    url: item.html_url,
  };
}

// A PR closed without a merge is "landed" when the maintainer applied its commits by hand (data.json "landed").
function statusOf(pr, entry) {
  if (pr.state === 'open') return pr.draft ? 'draft' : 'open';
  if (pr.merged) return 'merged';
  return entry && entry.landed ? 'landed' : 'closed';
}

// The "Merged / landed" filter and count cover both statuses.
const matchesFilter = (status, filter) => filter === 'all' || status === filter || (filter === 'merged' && status === 'landed');

const dateOnly = (iso) => new Date(iso).toISOString().slice(0, 10);
const relTimeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function relativeTime(ts) {
  const secs = Math.round((ts - Date.now()) / 1000);
  const steps = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, size] of steps) {
    if (Math.abs(secs) >= size) return relTimeFormat.format(Math.round(secs / size), unit);
  }
  return relTimeFormat.format(secs, 'second');
}

// Filter state lives in the URL hash (for example #status=open&g=4281&sort=oldest), so a filtered view can be shared.
const DEFAULT_FILTERS = { status: 'all', q: '', g: 'all', sort: 'newest', view: 'list' };

function filtersFromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const status = p.get('status');
  const sort = p.get('sort');
  return {
    status: status === 'all' || STATUSES.includes(status) ? status : 'all',
    q: p.get('q') || '',
    g: p.get('g') || 'all',
    sort: ['newest', 'oldest', 'status'].includes(sort) ? sort : 'newest',
    view: p.get('view') === 'grouped' ? 'grouped' : 'list',
  };
}

function filtersToHash(f) {
  const p = new URLSearchParams();
  if (f.status !== 'all') p.set('status', f.status);
  if (f.q) p.set('q', f.q);
  if (f.g !== 'all') p.set('g', f.g);
  if (f.sort !== 'newest') p.set('sort', f.sort);
  if (f.view !== 'list') p.set('view', f.view);
  const s = p.toString();
  history.replaceState(null, '', s ? `#${s}` : location.pathname + location.search);
}

// Dark mode follows the system until the visitor picks one; that choice is remembered.
const systemDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function useTheme() {
  const [saved, setSaved] = useState(() => storage.read(THEME_KEY));
  const [systemIsDark, setSystemIsDark] = useState(() => Boolean(systemDark && systemDark.matches));
  useEffect(() => {
    if (!systemDark) return undefined;
    const onChange = (e) => setSystemIsDark(e.matches);
    systemDark.addEventListener('change', onChange);
    return () => systemDark.removeEventListener('change', onChange);
  }, []);
  const dark = saved ? saved === 'dark' : systemIsDark;
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);
  const toggle = () => {
    const next = dark ? 'light' : 'dark';
    storage.write(THEME_KEY, next);
    setSaved(next);
  };
  return { dark, toggle };
}

function proposalIssueUrl(p, answer) {
  const title = `Proposal ${p.id}: ${answer.label}, ${p.title}`;
  const body = [
    `**Proposal:** ${p.title} (\`${p.id}\`)`,
    `**Answer:** ${answer.label}`,
    '',
    '### Problem',
    p.problem,
    '',
    '### Evidence',
    p.evidence,
    '',
    '### Plan',
    ...p.plan.map((step, i) => `${i + 1}. ${step}`),
    '',
    `**Size:** ${p.size}`,
    `**Risk:** ${p.risk}`,
    (p.related || []).length ? `**Related:** ${p.related.map((n) => `#${n}`).join(', ')}` : '',
  ].join('\n');
  return `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

/* ---------- small pieces ---------- */

function StatusBadge({ status }) {
  const meta = STATUS_META[status];
  return html`
    <span class=${`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${meta.tone}`}>
      <span aria-hidden="true">${meta.icon}</span>${meta.label}
    </span>`;
}

// Mermaid diagrams. The CDN script is optional: if it is missing, the source is shown instead.
let mermaidTheme = null;
let diagramCount = 0;

function initMermaid(dark) {
  const theme = dark ? 'dark' : 'default';
  if (mermaidTheme === theme) return;
  window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme });
  mermaidTheme = theme;
}

function useIsDark() {
  const root = document.documentElement;
  const [dark, setDark] = useState(() => root.classList.contains('dark'));
  useEffect(() => {
    const sync = () => setDark(root.classList.contains('dark'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

function Diagram({ source }) {
  const dark = useIsDark();
  const [result, setResult] = useState(null);
  useEffect(() => {
    let live = true;
    const id = `mermaid-diagram-${++diagramCount}`;
    setResult(null);
    (async () => {
      try {
        if (!window.mermaid) throw new Error('mermaid did not load');
        initMermaid(dark);
        const { svg } = await window.mermaid.render(id, source);
        if (live) setResult({ svg });
      } catch (err) {
        if (live) setResult({ error: true });
      } finally {
        // A failed render can leave its temporary element in <body>.
        [id, `d${id}`].forEach((n) => { const el = document.getElementById(n); if (el) el.remove(); });
      }
    })();
    return () => { live = false; };
  }, [source, dark]);
  return html`
    <div class="min-w-0">
      <h5 class=${LABEL_HEAD}>Diagram</h5>
      ${result && result.error
        ? html`
            <p class="mt-1 text-sm font-medium text-amber-800 dark:text-amber-300">Diagram could not be rendered</p>
            <pre class="mt-1 overflow-x-auto whitespace-pre rounded-lg bg-slate-100 p-3 font-mono text-xs leading-relaxed text-slate-800 dark:bg-slate-950 dark:text-slate-200">${source}</pre>`
        : html`
            <div role="img" aria-label="Diagram" class="mt-1 overflow-x-auto rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950"
              dangerouslySetInnerHTML=${{ __html: result && result.svg ? result.svg : '' }}></div>`}
    </div>`;
}

function Field({ title, children }) {
  return html`
    <div>
      <h5 class=${LABEL_HEAD}>${title}</h5>
      <p class="mt-1 text-sm leading-relaxed text-slate-800 dark:text-slate-200">${children}</p>
    </div>`;
}

function ListField({ title, items, mono }) {
  if (!items || !items.length) return null;
  return html`
    <div>
      <h5 class=${LABEL_HEAD}>${title}</h5>
      <ul class=${`mt-1 list-disc space-y-1 pl-5 text-sm text-slate-800 dark:text-slate-200 ${mono ? 'font-mono text-xs' : ''}`}>
        ${items.map((item, i) => html`<li key=${i} class="break-words">${mono ? html`<${Name} text=${item} />` : item}</li>`)}
      </ul>
    </div>`;
}

function CodeBlock({ label, text }) {
  return html`
    <div class="min-w-0">
      <h5 class=${LABEL_HEAD}>${label}</h5>
      <pre class="mt-1 whitespace-pre-wrap break-words rounded-lg bg-slate-100 p-3 font-mono text-xs leading-relaxed text-slate-800 dark:bg-slate-950 dark:text-slate-200">${text}</pre>
    </div>`;
}

// Breaks a name after each underscore, using <wbr>, so long test names wrap at underscores rather than mid-word.
function Name({ text }) {
  return html`<code class="break-normal">${text.split('_').map((part, i) => html`<${React.Fragment} key=${i}>${i > 0 ? html`_<wbr />` : null}${part}</${React.Fragment}>`)}</code>`;
}

function CaseCard({ c }) {
  return html`
    <article class="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <h6 class="font-mono text-sm font-semibold"><${Name} text=${c.case} /></h6>
      <dl class="mt-2 grid gap-2 text-sm">
        <div><dt class=${LABEL_HEAD}>Correct</dt><dd class="break-words">${c.correct}</dd></div>
        <div><dt class=${LABEL_HEAD}>v8</dt><dd class="break-words">${c.before}</dd></div>
        <div><dt class=${LABEL_HEAD}>PR before</dt><dd class="break-words">${c.pr_first_version}</dd></div>
        <div><dt class=${LABEL_HEAD}>PR now</dt><dd class="break-words">${c.after}</dd></div>
        <div><dt class=${LABEL_HEAD}>Covered by</dt><dd class="text-xs"><${Name} text=${c.covered_by} /></dd></div>
      </dl>
    </article>`;
}

function CasesTable({ cases }) {
  return html`
    <div>
      <h5 class=${LABEL_HEAD}>Cases</h5>
      <div class="mt-2 grid gap-3 sm:hidden">
        ${cases.map((c) => html`<${CaseCard} key=${c.case} c=${c} />`)}
      </div>
      <div class="mt-2 hidden overflow-x-auto rounded-lg border border-slate-200 sm:block dark:border-slate-800">
        <table class="min-w-[40rem] text-left text-xs text-slate-800 dark:text-slate-200">
          <thead class="sticky top-0 z-10 bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <tr>
              <th scope="col" class="px-3 py-2 font-semibold">Case</th>
              <th scope="col" class="px-3 py-2 font-semibold">Correct</th>
              <th scope="col" class="px-3 py-2 font-semibold">v8</th>
              <th scope="col" class="px-3 py-2 font-semibold">PR before</th>
              <th scope="col" class="px-3 py-2 font-semibold">PR now</th>
              <th scope="col" class="px-3 py-2 font-semibold">Covered by</th>
            </tr>
          </thead>
          <tbody>
            ${cases.map((c) => html`
              <tr key=${c.case} class="border-t border-slate-200 align-top dark:border-slate-800">
                <th scope="row" class="px-3 py-2 font-mono font-semibold"><${Name} text=${c.case} /></th>
                <td class="px-3 py-2">${c.correct}</td>
                <td class="px-3 py-2">${c.before}</td>
                <td class="px-3 py-2">${c.pr_first_version}</td>
                <td class="px-3 py-2">${c.after}</td>
                <td class="px-3 py-2 text-xs"><${Name} text=${c.covered_by} /></td>
              </tr>`)}
          </tbody>
        </table>
      </div>
    </div>`;
}

function GitHubDescription({ body }) {
  const safe = useMemo(() => renderMarkdown(body), [body]);
  if (!body.trim()) return html`<p class="text-sm text-slate-500 dark:text-slate-400">No description on GitHub.</p>`;
  return html`<div class="md break-words text-sm text-slate-800 dark:text-slate-200" dangerouslySetInnerHTML=${{ __html: safe }} />`;
}

function CIStatus({ number }) {
  const [ci, setCi] = useState({ state: 'loading' });
  useEffect(() => {
    let live = true;
    loadCI(number)
      .then((verdict) => { if (live) setCi(verdict); })
      .catch((err) => {
        if (live) setCi({ state: 'unknown', reason: err.rateLimited ? 'GitHub rate limit' : 'could not load' });
      });
    return () => { live = false; };
  }, [number]);
  const meta = CI_META[ci.state] || CI_META.unknown;
  return html`
    <p class=${`mt-4 text-sm font-medium ${meta.tone}`}>
      <span aria-hidden="true">${meta.icon}</span> CI: ${meta.label}${ci.reason ? ` (${ci.reason})` : ''}
    </p>`;
}

function WriteUp({ entry, body }) {
  return html`
    <div class="space-y-5">
      <${Field} title="Why">${entry.why}</${Field}>
      <${Field} title="What changed">${entry.what}</${Field}>
      <${Field} title="How it helps">${entry.helps}</${Field}>
      <div class="grid gap-4 md:grid-cols-2">
        <${CodeBlock} label="Before" text=${entry.before} />
        <${CodeBlock} label="After" text=${entry.after} />
      </div>
      <${ListField} title="Limits" items=${entry.limits} />
      <${ListField} title="Tests" items=${entry.tests} mono=${true} />
      ${entry.cases && entry.cases.length ? html`<${CasesTable} cases=${entry.cases} />` : null}
      <details class="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
        <summary class="cursor-pointer text-sm font-medium text-indigo-700 dark:text-indigo-300">Full GitHub description</summary>
        <div class="mt-3"><${GitHubDescription} body=${body} /></div>
      </details>
    </div>`;
}

function LandedNote({ landed }) {
  return html`
    <div class="rounded-lg border border-violet-300 bg-violet-50 p-3 text-sm dark:border-violet-700 dark:bg-violet-950/40">
      <p class="font-semibold text-violet-900 dark:text-violet-200"><span aria-hidden="true">◆</span> Landed by the maintainer</p>
      <p class="mt-1 text-slate-800 dark:text-slate-200">${landed.note}</p>
      <div class="mt-2 flex flex-wrap items-baseline gap-2">
        <span class=${LABEL_HEAD}>Commits</span>
        ${landed.commits.map((sha) => html`
          <a key=${sha} href=${COMMIT_URL(sha)} target="_blank" rel="noopener noreferrer" class="font-mono text-indigo-700 hover:underline dark:text-indigo-300">${sha}</a>`)}
      </div>
    </div>`;
}

function PRCard({ row, index = 0 }) {
  const { pr, status, entry } = row;
  const [expanded, setExpanded] = useState(false);
  const panelId = `pr-${pr.number}-details`;
  const hasWriteUp = Boolean(entry && entry.why);
  return html`
    <article style=${{ '--index': index % 8 }} class="reveal card-lift rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 dark:border-slate-800 dark:bg-slate-900">
      <div class="flex flex-wrap items-center gap-2">
        <${StatusBadge} status=${status} />
        <span class="font-mono text-sm tabular-nums text-slate-500 dark:text-slate-400">#${pr.number}</span>
        ${!hasWriteUp && html`<span class="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-300">No write-up yet</span>`}
      </div>
      <h4 class="mt-2 break-words text-[17px] font-semibold leading-snug tracking-tight">
        <a href=${pr.url} target="_blank" rel="noopener noreferrer" class="hover:underline">${pr.title}</a>
      </h4>
      <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Opened ${dateOnly(pr.created_at)} · ${pr.comments} ${pr.comments === 1 ? 'comment' : 'comments'}
        ${pr.labels.map((l) => html`<span key=${l} class="ml-2 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs dark:bg-slate-800">${l}</span>`)}
      </p>
      ${hasWriteUp && html`<p class="mt-3 text-slate-700 dark:text-slate-300">${entry.summary}</p>`}
      <button
        type="button"
        class="mt-4 text-sm font-medium text-indigo-700 hover:underline dark:text-indigo-300"
        aria-expanded=${expanded}
        aria-controls=${panelId}
        onClick=${() => setExpanded(!expanded)}
      >${expanded ? 'Hide details' : 'Show details'}</button>
      ${expanded && html`
        <div id=${panelId} class="mt-4 border-t border-slate-200 pt-4 dark:border-slate-800">
          ${entry && entry.diagram ? html`<div class="mb-5"><${Diagram} source=${entry.diagram} /></div>` : null}
          ${entry && entry.landed ? html`<div class="mb-5"><${LandedNote} landed=${entry.landed} /></div>` : null}
          ${hasWriteUp
            ? html`<${WriteUp} entry=${entry} body=${pr.body} />`
            : html`<${GitHubDescription} body=${pr.body} />`}
          <${CIStatus} number=${pr.number} />
        </div>`}
    </article>`;
}

function Proposal({ proposal: p }) {
  return html`
    <article class="card-lift rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 dark:border-slate-800 dark:bg-slate-900">
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <span class="font-mono text-slate-500 dark:text-slate-400">${p.id}</span>
        <span class=${`rounded-full px-2.5 py-0.5 font-semibold ring-1 ring-inset ${RISK_TONE[p.risk] || RISK_TONE.medium}`}>Risk: ${p.risk}</span>
        <span class="rounded-full bg-slate-100 px-2.5 py-0.5 font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-300">Size: ${p.size}</span>
      </div>
      <h4 class="mt-2 text-base font-semibold leading-snug">${p.title}</h4>
      <div class="mt-4 space-y-4">
        ${p.diagram ? html`<${Diagram} source=${p.diagram} />` : null}
        <${Field} title="Problem">${p.problem}</${Field}>
        <${Field} title="Evidence">${p.evidence}</${Field}>
        <div>
          <h5 class=${LABEL_HEAD}>Plan</h5>
          <ol class="mt-1 list-decimal space-y-1 pl-5 text-sm text-slate-800 dark:text-slate-200">
            ${p.plan.map((step, i) => html`<li key=${i} class="break-words">${step}</li>`)}
          </ol>
        </div>
      </div>
      ${(p.related || []).length ? html`
        <p class="mt-4 text-sm">
          <span class=${LABEL_HEAD}>Related</span>
          ${p.related.map((n) => html`
            <a key=${n} href=${`https://github.com/${REPO}/issues/${n}`} target="_blank" rel="noopener noreferrer" class="ml-2 font-mono text-indigo-700 hover:underline dark:text-indigo-300">#${n}</a>`)}
        </p>` : null}
      <div class="mt-5 flex flex-wrap gap-2">
        ${ANSWERS.map((a) => html`
          <a key=${a.label} href=${proposalIssueUrl(p, a)} target="_blank" rel="noopener noreferrer" class=${BUTTON}>
            <span aria-hidden="true">${a.emoji}</span> ${a.label}
          </a>`)}
      </div>
      <p class="mt-2 text-xs text-slate-500 dark:text-slate-400">Opens a new issue draft on GitHub with this proposal and your answer filled in. Nothing is stored on this page.</p>
    </article>`;
}

/* ---------- page sections ---------- */

function Header({ theme, pulls, refreshing, onRefresh }) {
  let updated = 'Loading…';
  if (pulls.failed) updated = 'Not loaded';
  else if (pulls.at) updated = `Last updated ${relativeTime(pulls.at)}`;
  return html`
    <header class="sticky top-0 z-30 border-b border-slate-200 bg-white/85 backdrop-blur dark:border-slate-800 dark:bg-slate-900/85">
      <div class="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <div class="flex min-w-0 items-center gap-3">
          <img src=${`https://github.com/${AUTHOR}.png?size=96`} alt=${`${AUTHOR} avatar`} width="40" height="40" class="h-10 w-10 shrink-0 rounded-full ring-1 ring-slate-900/10 dark:ring-white/15" />
          <div class="min-w-0">
            <h1 class="text-xl font-semibold tracking-tight">Graphify contributions</h1>
            <p class="text-sm text-slate-600 dark:text-slate-400">
              by ${AUTHOR} · <a href=${`https://github.com/${REPO}`} target="_blank" rel="noopener noreferrer" class="font-medium text-indigo-700 hover:underline dark:text-indigo-300">${REPO}</a>
            </p>
            <p class="text-xs text-slate-500 dark:text-slate-400">${updated}</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button type="button" class=${BUTTON} onClick=${onRefresh} disabled=${refreshing}>${refreshing ? 'Refreshing…' : 'Refresh'}</button>
          <button type="button" class=${BUTTON}
            aria-label=${theme.dark ? 'Switch to light mode' : 'Switch to dark mode'} onClick=${theme.toggle}>
            ${theme.dark ? '☀ Light mode' : '☾ Dark mode'}
          </button>
        </div>
      </div>
    </header>`;
}

function SummaryStrip({ counts, active, onPick }) {
  return html`
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      ${STATUSES.map((s, i) => html`
        <button
          key=${s}
          type="button"
          aria-pressed=${active === s}
          onClick=${() => onPick(s)}
          class=${`pressable rounded-2xl border bg-white p-4 text-left dark:bg-slate-900 ${active === s ? 'border-indigo-500 ring-1 ring-indigo-500' : 'border-slate-200 hover:border-indigo-300 dark:border-slate-800 dark:hover:border-indigo-700'}`}
        >
          <span class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
            <span aria-hidden="true">${STATUS_META[s].icon}</span>${STATUS_META[s].filterLabel || STATUS_META[s].label}
          </span>
          <span class="mt-1 block text-2xl font-semibold tabular-nums tracking-tight">${counts[s]}</span>
        </button>`)}
    </div>`;
}

function Toolbar({ filters, update, groups }) {
  const tabs = ['all', ...STATUSES];
  return html`
    <div class="mt-6 space-y-3">
      <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <label class="min-w-0 flex-1 text-sm font-medium">
          <span class="mb-1 block">Search</span>
          <input type="search" class=${INPUT} placeholder="Title, number or summary" value=${filters.q}
            onInput=${(e) => update({ q: e.target.value })} />
        </label>
        <label class="text-sm font-medium">
          <span class="mb-1 block">Group</span>
          <select class=${INPUT} value=${filters.g} onChange=${(e) => update({ g: e.target.value })}>
            <option value="all">All</option>
            ${groups.map((g) => html`<option key=${g.id} value=${g.id}>#${g.issue} group</option>`)}
            <option value="none">Not in a group</option>
          </select>
        </label>
        <label class="text-sm font-medium">
          <span class="mb-1 block">Sort</span>
          <select class=${INPUT} value=${filters.sort} onChange=${(e) => update({ sort: e.target.value })}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="status">By status</option>
          </select>
        </label>
        <div class="text-sm font-medium">
          <span class="mb-1 block">View</span>
          <div class="flex gap-2">
            ${[['list', 'List'], ['grouped', 'Grouped']].map(([value, label]) => html`
              <button key=${value} type="button" class=${`${BUTTON} ${filters.view === value ? 'ring-1 ring-indigo-500' : ''}`} aria-pressed=${filters.view === value}
                onClick=${() => update({ view: value })}>${label}</button>`)}
          </div>
        </div>
      </div>
      <div role="tablist" aria-label="Filter by status" class="flex flex-wrap gap-2">
        ${tabs.map((t) => html`
          <button key=${t} role="tab" type="button" aria-selected=${filters.status === t}
            onClick=${() => update({ status: t })}
            class=${`pressable whitespace-nowrap rounded-full px-3 py-1 text-sm font-medium ring-1 ring-inset ${filters.status === t
              ? 'bg-indigo-600 text-white ring-indigo-600 dark:bg-indigo-500 dark:ring-indigo-500'
              : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-800'}`}>
            ${t === 'all' ? 'All' : STATUS_META[t].filterLabel || STATUS_META[t].label}
          </button>`)}
      </div>
    </div>`;
}

function GroupSection({ section }) {
  const { group, rows } = section;
  const headingId = `group-${section.key}`;
  return html`
    <section aria-labelledby=${headingId} class="space-y-3">
      <h3 id=${headingId} class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-base font-semibold">
        ${group
          ? html`
            <span class="break-words">${group.title}</span>
            <a href=${`https://github.com/${REPO}/issues/${group.issue}`} target="_blank" rel="noopener noreferrer" class="text-sm font-medium text-indigo-700 hover:underline dark:text-indigo-300">Issue #${group.issue}</a>`
          : html`<span>Not in a group</span>`}
      </h3>
      <ul class="space-y-4">
        ${rows.map((r, i) => html`<li key=${r.pr.number}><${PRCard} row=${r} index=${i} /></li>`)}
      </ul>
    </section>`;
}

function Proposals({ items }) {
  if (!items.length) return html`<p class="text-sm text-slate-500 dark:text-slate-400">No proposals yet</p>`;
  return html`
    <ul class="grid gap-4">
      ${items.map((p) => html`<li key=${p.id}><${Proposal} proposal=${p} /></li>`)}
    </ul>`;
}

/* ---------- app ---------- */

function Footer() {
  const toTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });
  return html`
    <footer class="border-t border-slate-200 dark:border-slate-800">
      <div class="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-6 sm:px-6">
        <p class="text-sm text-slate-500 dark:text-slate-400">
          <a href=${`https://github.com/${REPO}`} target="_blank" rel="noopener noreferrer" class="font-medium text-indigo-700 hover:underline dark:text-indigo-300">${REPO}</a>
          <span class="mx-2" aria-hidden="true">·</span>by ${AUTHOR}
        </p>
        <button type="button" class=${BUTTON} onClick=${toTop}>Back to top</button>
      </div>
    </footer>`;
}

function App() {
  const theme = useTheme();
  const [content, setContent] = useState(null);
  const [contentFailed, setContentFailed] = useState(false);
  const [pulls, setPulls] = useState({ loading: true });
  const [refreshing, setRefreshing] = useState(false);
  const [filters, setFilters] = useState(filtersFromHash);

  const load = useCallback(async (force) => {
    setRefreshing(true);
    try {
      setPulls({ loading: false, ...(await loadPullRequests(force)) });
    } catch (err) {
      setPulls({ loading: false, failed: true });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetch('data.json')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('data.json'))))
      .then(setContent)
      .catch(() => setContentFailed(true));
    load(false);
  }, [load]);

  useEffect(() => { filtersToHash(filters); }, [filters]);

  useEffect(() => {
    const onHash = () => setFilters(filtersFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const update = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const toggleStatus = (s) => update({ status: filters.status === s ? 'all' : s });

  const rows = useMemo(() => {
    if (!content || !pulls.items) return [];
    const groupOf = (n) => content.groups.find((g) => g.prs.includes(n)) || null;
    return pulls.items.map(normalize).map((pr) => {
      const entry = content.prs[String(pr.number)] || null;
      return { pr, entry, status: statusOf(pr, entry), group: groupOf(pr.number) };
    });
  }, [content, pulls.items]);

  // Landed PRs are counted under "Merged / landed".
  const counts = useMemo(() => {
    const c = { open: 0, draft: 0, merged: 0, closed: 0 };
    rows.forEach((r) => { c[r.status === 'landed' ? 'merged' : r.status] += 1; });
    return c;
  }, [rows]);

  const visible = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    const list = rows.filter((r) => {
      if (!matchesFilter(r.status, filters.status)) return false;
      if (filters.g === 'none' && r.group) return false;
      if (filters.g !== 'all' && filters.g !== 'none' && (!r.group || r.group.id !== filters.g)) return false;
      if (!q) return true;
      const haystack = `#${r.pr.number} ${r.pr.title} ${(r.entry && r.entry.summary) || ''}`.toLowerCase();
      return haystack.includes(q);
    });
    const newest = (a, b) => b.pr.created_at.localeCompare(a.pr.created_at);
    const sorters = {
      newest,
      oldest: (a, b) => newest(b, a),
      status: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || newest(a, b),
    };
    return [...list].sort(sorters[filters.sort]);
  }, [rows, filters]);

  const sections = useMemo(() => {
    if (!content) return [];
    const out = content.groups
      .map((g) => ({
        key: g.id,
        group: g,
        rows: g.prs.map((n) => visible.find((r) => r.pr.number === n)).filter(Boolean),
      }))
      .filter((s) => s.rows.length);
    const loose = visible.filter((r) => !r.group);
    if (loose.length) out.push({ key: 'ungrouped', group: null, rows: loose });
    return out;
  }, [content, visible]);

  // Scroll entry reveals: IntersectionObserver only, transform and opacity only.
  // Placed after visible/sections so the dep array never hits a TDZ error.
  useEffect(() => {
    const els = Array.from(document.querySelectorAll('.reveal:not(.in)'));
    if (!els.length) return undefined;
    if (!('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('in'));
      return undefined;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.08 });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  });  // every render: a filter or view switch can mount new cards with the same count

  let body;
  if (contentFailed || pulls.failed) {
    body = html`<p role="alert" class="rounded-2xl border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200">
      Could not load the pull requests from GitHub, and the local copy is unavailable.</p>`;
  } else if (pulls.loading || !content) {
    body = html`<div role="status" aria-label="Loading pull requests" class="space-y-4">
      ${[0, 1, 2].map((i) => html`
        <div key=${i} class="skeleton rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <div class="h-5 w-2/3 rounded bg-slate-200 dark:bg-slate-800"></div>
          <div class="mt-3 h-4 w-1/3 rounded bg-slate-200 dark:bg-slate-800"></div>
          <div class="mt-3 h-4 w-full rounded bg-slate-200 dark:bg-slate-800"></div>
        </div>`)}
    </div>`;
  } else if (!visible.length) {
    body = html`
      <div class="rounded-2xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-600 dark:border-slate-700 dark:text-slate-400">
        <p>No pull requests match these filters.</p>
        <button type="button" class="mt-3 ${BUTTON}" onClick=${() => setFilters({ ...DEFAULT_FILTERS })}>Clear filters</button>
      </div>`;
  } else if (filters.view === 'grouped') {
    body = html`<div class="space-y-8">${sections.map((s) => html`<${GroupSection} key=${s.key} section=${s} />`)}</div>`;
  } else {
    body = html`<ul class="space-y-4">${visible.map((r, i) => html`<li key=${r.pr.number}><${PRCard} row=${r} index=${i} /></li>`)}</ul>`;
  }

  const snapshotDate = pulls.source === 'snapshot' ? dateOnly(new Date(pulls.at).toISOString()) : null;

  return html`
    <div class="min-h-screen">
      <a href="#prs-heading" class="skip-link">Skip to content</a>
      <${Header} theme=${theme} pulls=${pulls} refreshing=${refreshing} onRefresh=${() => load(true)} />
      <main id="main" class="mx-auto max-w-5xl space-y-12 px-4 py-12 sm:px-6">
        ${snapshotDate && html`
          <div role="status" class="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-200">
            Showing snapshot from ${snapshotDate} (${pulls.reason})
          </div>`}

        <section aria-labelledby="prs-heading">
          <h2 id="prs-heading" class="text-xl font-semibold tracking-tight">Pull requests</h2>
          <div class="mt-4">
            <${SummaryStrip} counts=${counts} active=${filters.status} onPick=${toggleStatus} />
          </div>
          <${Toolbar} filters=${filters} update=${update} groups=${content ? content.groups : []} />
          ${!pulls.loading && !pulls.failed && content && html`
            <p class="mt-4 text-sm text-slate-500 dark:text-slate-400">Showing ${visible.length} of ${rows.length}</p>`}
          <div class="mt-3">${body}</div>
        </section>

        <section aria-labelledby="proposals-heading">
          <h2 id="proposals-heading" class="text-xl font-semibold tracking-tight">Proposals</h2>
          <p class="mt-1 max-w-[65ch] text-sm leading-relaxed text-slate-600 dark:text-slate-400">Ideas for the maintainer to approve before any code is written.</p>
          <div class="mt-4">
            ${content ? html`<${Proposals} items=${content.proposals || []} />` : null}
          </div>
        </section>
      </main>
      <${Footer} />
    </div>`;
}

ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
