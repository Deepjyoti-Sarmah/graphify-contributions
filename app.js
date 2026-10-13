/* Graphify contributions page. React + htm, no JSX and no build step.
   Every "why", "what" and "limits" line comes from data.json; GitHub supplies status, CI and diff size. */
const { useState, useEffect, useMemo, useCallback, useRef } = React;
const html = htm.bind(React.createElement);
const Fragment = React.Fragment;

const REPO = 'Graphify-Labs/graphify';
const AUTHOR = 'Deepjyoti-Sarmah';
const API_BASE = window.CONTRIB_API_BASE || 'https://api.github.com';
const SEARCH_PATH = `/search/issues?q=repo:${REPO}+author:${AUTHOR}+is:pr&per_page=100&sort=created&order=desc`;
const CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_KEY = 'contrib:search:v1';
const THEME_KEY = 'contrib:theme';
const STATUSES = ['open', 'draft', 'merged', 'closed'];
const STATUS_ORDER = { open: 0, draft: 1, merged: 2, landed: 2, closed: 3 };
const ISSUE_URL = (n) => `https://github.com/${REPO}/issues/${n}`;
const COMMIT_URL = (sha) => `https://github.com/${REPO}/commit/${sha}`;
const ANSWERS = ['Go ahead', 'Discuss', 'Not now'];

const STATUS_META = {
  open: { label: 'Open', tag: 'tag-green' },
  draft: { label: 'Draft', tag: 'tag-gray' },
  merged: { label: 'Merged', tag: 'tag-purple', filterLabel: 'Merged or landed' },
  landed: { label: 'Landed', tag: 'tag-purple' },
  closed: { label: 'Closed', tag: 'tag-red' },
};

const CI_META = {
  loading: { label: 'CI checking', tag: 'tag-gray' },
  passing: { label: 'CI passing', tag: 'tag-green' },
  failing: { label: 'CI failing', tag: 'tag-red' },
  pending: { label: 'CI running', tag: 'tag-yellow' },
  unknown: { label: 'CI unknown', tag: 'tag-gray' },
};

const RISK_TAG = { low: 'tag-green', medium: 'tag-yellow', high: 'tag-red' };

const LABEL = 'text-[12px] font-medium uppercase tracking-[0.08em] text-muted';
const ICON_BUTTON = 'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-subtle hover:text-ink disabled:opacity-50';
const CONTROL = 'h-9 rounded-md border border-line bg-surface px-3 text-sm text-ink transition-colors hover:border-muted/40';

/* ---------- storage, network ---------- */

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

function ciState(runs) {
  const FAILING = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'];
  const PASSING = ['success', 'neutral', 'skipped'];
  if (!runs.length) return 'unknown';
  if (runs.some((r) => r.status === 'completed' && FAILING.includes(r.conclusion))) return 'failing';
  if (runs.some((r) => r.status !== 'completed')) return 'pending';
  if (runs.every((r) => PASSING.includes(r.conclusion))) return 'passing';
  return 'unknown';
}

// Loaded only when a PR is opened: diff size from the pull, then CI for its head commit.
async function loadDetails(number) {
  const key = `contrib:pull:v2:${number}`;
  const hit = freshCache(key);
  if (hit) return hit.data;
  const pull = await github(`/repos/${REPO}/pulls/${number}`);
  let ci = 'unknown';
  try {
    const runs = await github(`/repos/${REPO}/commits/${pull.head.sha}/check-runs?per_page=100`);
    ci = ciState(runs.check_runs);
  } catch (e) { /* keep "unknown" */ }
  const data = { ci, additions: pull.additions, deletions: pull.deletions, files: pull.changed_files, commits: pull.commits };
  storage.write(key, { t: Date.now(), data });
  return data;
}

function useDetails(number) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let live = true;
    loadDetails(number)
      .then((d) => { if (live) setState(d); })
      .catch((err) => { if (live) setState({ failed: true, reason: err.rateLimited ? 'GitHub rate limit' : 'could not load' }); });
    return () => { live = false; };
  }, [number]);
  return state;
}

/* ---------- data shaping ---------- */

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

const matchesFilter = (status, filter) => filter === 'all' || status === filter || (filter === 'merged' && status === 'landed');

// "fix(dedup): say what ... (#4281)" -> type fix, scope dedup, issue 4281, text "Say what ...".
function parseTitle(raw) {
  let text = raw;
  let type = null;
  let scope = null;
  let issue = null;
  const conv = text.match(/^(\w+)(?:\(([^)]+)\))?!?:\s*/);
  if (conv) { type = conv[1]; scope = conv[2] || null; text = text.slice(conv[0].length); }
  const ref = text.match(/\s*\(#(\d+)\)\s*$/);
  if (ref) { issue = Number(ref[1]); text = text.slice(0, ref.index); }
  return { text: text.charAt(0).toUpperCase() + text.slice(1), type, scope, issue };
}

const dateOnly = (iso) => new Date(iso).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
const relTimeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function relativeTime(ts) {
  const secs = Math.round((ts - Date.now()) / 1000);
  const steps = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, size] of steps) {
    if (Math.abs(secs) >= size) return relTimeFormat.format(Math.round(secs / size), unit);
  }
  return relTimeFormat.format(secs, 'second');
}

// Filter state and the open PR live in the URL hash (for example #status=open&pr=4362), so any view can be shared.
const DEFAULT_FILTERS = { status: 'all', q: '', g: 'all', sort: 'newest', view: 'list', pr: null };

function filtersFromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const status = p.get('status');
  const sort = p.get('sort');
  const pr = Number(p.get('pr'));
  return {
    status: status === 'all' || STATUSES.includes(status) ? status : 'all',
    q: p.get('q') || '',
    g: p.get('g') || 'all',
    sort: ['newest', 'oldest', 'status'].includes(sort) ? sort : 'newest',
    view: p.get('view') === 'grouped' ? 'grouped' : 'list',
    pr: Number.isInteger(pr) && pr > 0 ? pr : null,
  };
}

function filtersToHash(f) {
  const p = new URLSearchParams();
  if (f.status !== 'all') p.set('status', f.status);
  if (f.q) p.set('q', f.q);
  if (f.g !== 'all') p.set('g', f.g);
  if (f.sort !== 'newest') p.set('sort', f.sort);
  if (f.view !== 'list') p.set('view', f.view);
  if (f.pr) p.set('pr', String(f.pr));
  const s = p.toString();
  history.replaceState(null, '', s ? `#${s}` : location.pathname + location.search);
}

/* ---------- theme ---------- */

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

function useIsDark() {
  const root = document.documentElement;
  const [dark, setDark] = useState(() => root.classList.contains('dark'));
  useEffect(() => {
    const sync = () => setDark(root.classList.contains('dark'));
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/* ---------- icons (inline SVG, one stroke weight) ---------- */

const svg = (d, size = 16) => html`
  <svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const IconSun = () => svg(html`<circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />`);
const IconMoon = () => svg(html`<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />`);
const IconRefresh = () => svg(html`<path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" />`);
const IconArrow = () => svg(html`<path d="M7 17L17 7M8 7h9v9" />`, 13);
const IconLink = () => svg(html`<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />`, 14);
const IconChevron = () => html`<span class="chev inline-flex">${svg(html`<path d="M9 6l6 6-6 6" />`, 14)}</span>`;

function PlusMinus({ open }) {
  return html`
    <span class="mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line text-muted transition-colors group-hover:border-muted/50 group-hover:text-ink" aria-hidden="true">
      ${svg(open ? html`<path d="M5 12h14" />` : html`<path d="M12 5v14M5 12h14" />`, 14)}
    </span>`;
}

/* ---------- prose helpers ---------- */

function Tag({ tag, label }) {
  return html`<span class=${`tag ${tag}`}><span class="dot"></span>${label}</span>`;
}

function ExternalLink({ href, children, className = '' }) {
  return html`<a href=${href} target="_blank" rel="noopener noreferrer" class=${`link inline-flex items-center gap-0.5 ${className}`}>${children}<${IconArrow} /></a>`;
}

// Prose from data.json is plain text. Identifiers (anything with _ or /, a call like f(), a file
// name) are shown as inline code, and #123 becomes an issue link. No HTML is ever injected.
const CODE_LIKE = /[_/]|\(\)$|\.(py|md|html|json|sh|js|ts|yml|yaml)$|^\.[a-z]/i;

function Rich({ text }) {
  if (!text) return null;
  return String(text).split(/(\s+)/).map((part, i) => {
    if (!part || /^\s+$/.test(part)) return part;
    const m = part.match(/^([("']*)(.*?)([)"'.,;:]*)$/);
    let [, pre, core, post] = m;
    if (core.endsWith('(') && post.startsWith(')')) { core += ')'; post = post.slice(1); }
    if (/^#\d+$/.test(core)) {
      return html`<${Fragment} key=${i}>${pre}<a class="link" href=${ISSUE_URL(core.slice(1))} target="_blank" rel="noopener noreferrer">${core}</a>${post}</${Fragment}>`;
    }
    if (core && CODE_LIKE.test(core) && !/^https?:/.test(core)) {
      return html`<${Fragment} key=${i}>${pre}<code class="ic">${core}</code>${post}</${Fragment}>`;
    }
    return part;
  });
}

// Breaks a name after each underscore so long test names wrap at underscores rather than mid-word.
function Name({ text }) {
  return html`<code class="font-mono">${text.split('_').map((part, i) => html`<${Fragment} key=${i}>${i > 0 ? html`_<wbr />` : null}${part}</${Fragment}>`)}</code>`;
}

function Section({ label, children }) {
  return html`
    <div class="grid gap-2 md:grid-cols-[8.5rem_1fr] md:gap-8">
      <h4 class=${`${LABEL} md:pt-1`}>${label}</h4>
      <div class="min-w-0">${children}</div>
    </div>`;
}

// Diagrams and tables need the full width, so their label sits above them.
function Wide({ label, children }) {
  return html`
    <div class="space-y-3">
      <h4 class=${LABEL}>${label}</h4>
      ${children}
    </div>`;
}

function Paragraph({ text }) {
  return html`<p class="max-w-[68ch] text-[16.5px] leading-[1.75] text-ink"><${Rich} text=${text} /></p>`;
}

/* ---------- diagrams ---------- */

const MERMAID_VARS = {
  light: {
    fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif', fontSize: '16px',
    background: '#FFFFFF', primaryColor: '#F4F3F0', primaryBorderColor: '#D6D5D1', primaryTextColor: '#2F3437',
    secondaryColor: '#F4F3F0', tertiaryColor: '#FFFFFF', lineColor: '#A3A29E', textColor: '#2F3437',
    clusterBkg: '#FBFBFA', clusterBorder: '#E3E2DE', edgeLabelBackground: '#FFFFFF',
    actorBkg: '#F4F3F0', actorBorder: '#D6D5D1', actorTextColor: '#2F3437', actorLineColor: '#DAD9D5',
    signalColor: '#69686A', signalTextColor: '#2F3437', labelBoxBkgColor: '#F4F3F0', labelTextColor: '#2F3437',
    noteBkgColor: '#FBF3DB', noteBorderColor: '#EAD9A6', noteTextColor: '#5C4300',
  },
  dark: {
    fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif', fontSize: '16px',
    background: '#202020', primaryColor: '#2A2A2A', primaryBorderColor: '#454545', primaryTextColor: '#E6E6E4',
    secondaryColor: '#2A2A2A', tertiaryColor: '#202020', lineColor: '#7D7C78', textColor: '#E6E6E4',
    clusterBkg: '#1C1C1C', clusterBorder: '#3A3A3A', edgeLabelBackground: '#202020',
    actorBkg: '#2A2A2A', actorBorder: '#454545', actorTextColor: '#E6E6E4', actorLineColor: '#3F3F3F',
    signalColor: '#A9A8A4', signalTextColor: '#E6E6E4', labelBoxBkgColor: '#2A2A2A', labelTextColor: '#E6E6E4',
    noteBkgColor: '#3A3320', noteBorderColor: '#5A4E2A', noteTextColor: '#EBDDB5',
  },
};

// Flowcharts can tag nodes :::bad, :::good or :::same. The colors follow the page theme.
const FLOW_CLASSES = {
  light: [
    'classDef bad fill:#FDEBEC,stroke:#EBB9B7,color:#9F2F2D',
    'classDef good fill:#EDF3EC,stroke:#BBD3B8,color:#346538',
    'classDef same fill:#E1F3FE,stroke:#B5D9F0,color:#1F6C9F',
  ],
  dark: [
    'classDef bad fill:#3B2524,stroke:#6E3A38,color:#F2B5B3',
    'classDef good fill:#22301F,stroke:#3F6141,color:#A9D3AC',
    'classDef same fill:#1E2E3B,stroke:#35556E,color:#9CCEF0',
  ],
};

let mermaidTheme = null;
let diagramCount = 0;

function initMermaid(dark) {
  const mode = dark ? 'dark' : 'light';
  if (mermaidTheme === mode) return;
  window.mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: MERMAID_VARS[mode],
    flowchart: { curve: 'basis', padding: 14, nodeSpacing: 32, rankSpacing: 40 },
    sequence: { mirrorActors: false, messageMargin: 30, boxMargin: 10, noteMargin: 10, actorMargin: 60 },
  });
  mermaidTheme = mode;
}

function withThemeClasses(source, dark) {
  if (!/^\s*(flowchart|graph)\b/.test(source)) return source;
  return `${source}\n${FLOW_CLASSES[dark ? 'dark' : 'light'].join('\n')}`;
}

function Diagram({ source, caption }) {
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
        const { svg: out } = await window.mermaid.render(id, withThemeClasses(source, dark));
        if (live) setResult({ svg: out });
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
    <figure class="min-w-0">
      ${result && result.error
        ? html`
            <pre class="overflow-x-auto rounded-lg border border-line bg-subtle p-4 font-mono text-xs leading-relaxed">${source}</pre>
            <figcaption class="mt-2 text-xs text-muted">The diagram could not be drawn, so its source is shown.</figcaption>`
        : html`
            <div role="img" aria-label=${caption || 'Diagram'} class="diagram min-h-[6rem] overflow-x-auto rounded-lg border border-line bg-surface p-4 sm:p-6"
              dangerouslySetInnerHTML=${{ __html: result && result.svg ? result.svg : '' }}></div>
            ${caption && html`<figcaption class="mt-2 text-xs text-muted">${caption}</figcaption>`}`}
    </figure>`;
}

/* ---------- PR detail pieces ---------- */

function BeforeAfter({ before, after }) {
  const box = (label, text, dot) => html`
    <figure class="min-w-0 overflow-hidden rounded-lg border border-line bg-surface">
      <figcaption class=${`flex items-center gap-2 border-b border-line px-4 py-2 ${LABEL}`}>
        <span class=${`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true"></span>${label}
      </figcaption>
      <pre class="whitespace-pre-wrap break-words px-4 py-3 font-mono text-[13.5px] leading-[1.7] text-ink">${text}</pre>
    </figure>`;
  return html`<div class="grid gap-3 md:grid-cols-2">${box('Before', before, 'bad-dot')}${box('After', after, 'good-dot')}</div>`;
}

// A case result is right when it starts with "ok". Anything else in a result column is shown as wrong.
const isOk = (v) => /^ok\b/i.test(v || '');

function Verdict({ value }) {
  return html`<span class=${isOk(value) ? 'good-text' : 'bad-text'}>${value}</span>`;
}

function CasesTable({ cases }) {
  const score = (key) => cases.filter((c) => isOk(c[key])).length;
  const cols = [['before', 'v8'], ['pr_first_version', 'First version'], ['after', 'This PR']]
    .filter(([key]) => cases.some((c) => c[key]));
  return html`
    <div class="space-y-4">
      <div class="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        ${cols.map(([key, label]) => html`
          <span key=${key} class="text-muted">${label} <span class="font-medium tabular-nums text-ink">${score(key)} of ${cases.length}</span> right</span>`)}
      </div>
      <div class="grid gap-3 sm:hidden">
        ${cases.map((c) => html`
          <article key=${c.case} class="rounded-lg border border-line bg-surface p-4">
            <h5 class="font-mono text-sm font-medium">${c.case}</h5>
            <p class="mt-1 text-sm text-muted">${c.correct}</p>
            <dl class="mt-3 grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1.5 text-sm">
              ${cols.map(([key, label]) => html`<${Fragment} key=${key}><dt class="text-muted">${label}</dt><dd><${Verdict} value=${c[key]} /></dd></${Fragment}>`)}
            </dl>
            <p class="mt-3 text-xs text-muted"><${Name} text=${c.covered_by} /></p>
          </article>`)}
      </div>
      <div class="hidden overflow-x-auto sm:block">
        <table class="w-full min-w-[44rem] text-left text-[14px]">
          <thead>
            <tr class="border-b border-line">
              <th scope="col" class=${`py-2 pr-4 ${LABEL}`}>Case</th>
              <th scope="col" class=${`py-2 pr-4 ${LABEL}`}>Correct result</th>
              ${cols.map(([key, label]) => html`<th key=${key} scope="col" class=${`py-2 pr-4 ${LABEL}`}>${label}</th>`)}
              <th scope="col" class=${`py-2 ${LABEL}`}>Test</th>
            </tr>
          </thead>
          <tbody>
            ${cases.map((c) => html`
              <tr key=${c.case} class="border-b border-line align-top last:border-0">
                <th scope="row" class="py-3 pr-4 font-mono font-medium">${c.case}</th>
                <td class="py-3 pr-4 text-muted">${c.correct}</td>
                ${cols.map(([key]) => html`<td key=${key} class="py-3 pr-4"><${Verdict} value=${c[key]} /></td>`)}
                <td class="py-3 font-mono text-[12.5px] text-muted"><${Name} text=${c.covered_by} /></td>
              </tr>`)}
          </tbody>
        </table>
      </div>
    </div>`;
}

function Disclosure({ title, open, children }) {
  return html`
    <details class="group border-t border-line pt-4" open=${open}>
      <summary class="flex items-center gap-2 text-sm font-medium text-ink hover:text-accent">
        <${IconChevron} />${title}
      </summary>
      <div class="mt-4">${children}</div>
    </details>`;
}

function GitHubDescription({ body }) {
  const safe = useMemo(() => renderMarkdown(body), [body]);
  if (!body.trim()) return html`<p class="text-sm text-muted">No description on GitHub.</p>`;
  return html`<div class="md max-w-[72ch] break-words text-ink" dangerouslySetInnerHTML=${{ __html: safe }} />`;
}

function MetaBar({ pr, title, details, group, onOpenPr }) {
  const others = group ? group.prs.filter((n) => n !== pr.number) : [];
  const items = [];
  if (title.issue) items.push(html`<span>Issue <a class="link" href=${ISSUE_URL(title.issue)} target="_blank" rel="noopener noreferrer">#${title.issue}</a></span>`);
  if (others.length) {
    items.push(html`<span>With ${others.map((n, i) => html`<${Fragment} key=${n}>${i ? ', ' : ''}<a class="link" href=${`#pr=${n}`} onClick=${(e) => { e.preventDefault(); onOpenPr(n); }}>#${n}</a></${Fragment}>`)}</span>`);
  }
  items.push(html`<span>Opened ${dateOnly(pr.created_at)}</span>`);
  items.push(html`<span>${pr.comments} ${pr.comments === 1 ? 'comment' : 'comments'}</span>`);
  if (details.additions != null) {
    items.push(html`<span class="font-mono text-[13.5px]"><span class="good-text">+${details.additions}</span> <span class="bad-text">-${details.deletions}</span> <span class="text-muted">in ${details.files} ${details.files === 1 ? 'file' : 'files'}</span></span>`);
  }
  const ci = details.loading ? 'loading' : (details.ci || 'unknown');
  return html`
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted">
        <${Tag} tag=${CI_META[ci].tag} label=${CI_META[ci].label} />
        ${items.map((it, i) => html`<${Fragment} key=${i}><span aria-hidden="true" class="text-line">/</span>${it}</${Fragment}>`)}
      </div>
      <div class="flex shrink-0 items-center gap-4 text-sm">
        <${ExternalLink} href=${`${pr.url}/files`}>Files changed</${ExternalLink}>
        <${ExternalLink} href=${pr.url}>Open on GitHub</${ExternalLink}>
      </div>
    </div>`;
}

function LandedNote({ landed }) {
  return html`
    <div class="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
      <p><span class="font-medium">Landed by the maintainer.</span> <span class="text-muted">${landed.note}</span></p>
      <p class="flex flex-wrap gap-3 font-mono text-[13.5px]">
        ${landed.commits.map((sha) => html`<${ExternalLink} key=${sha} href=${COMMIT_URL(sha)}>${sha}</${ExternalLink}>`)}
      </p>
    </div>`;
}

function Detail({ row, title, group, onOpenPr }) {
  const { pr, entry } = row;
  const details = useDetails(pr.number);
  const hasWriteUp = Boolean(entry && entry.why);
  return html`
    <div class="panel space-y-10">
      <${MetaBar} pr=${pr} title=${title} details=${details} group=${group} onOpenPr=${onOpenPr} />
      ${entry && entry.landed ? html`<${LandedNote} landed=${entry.landed} />` : null}
      ${hasWriteUp ? html`
        <${BeforeAfter} before=${entry.before} after=${entry.after} />
        <div class="space-y-8">
          <${Section} label="Why"><${Paragraph} text=${entry.why} /></${Section}>
          <${Section} label="What changed"><${Paragraph} text=${entry.what} /></${Section}>
          <${Section} label="Who it helps"><${Paragraph} text=${entry.helps} /></${Section}>
          ${entry.diagram ? html`<${Wide} label="How it flows"><${Diagram} source=${entry.diagram} caption=${`How the flow changes in #${pr.number}`} /></${Wide}>` : null}
          ${entry.cases && entry.cases.length ? html`<${Wide} label="Cases"><${CasesTable} cases=${entry.cases} /></${Wide}>` : null}
          ${entry.limits && entry.limits.length ? html`
            <${Section} label="Limits">
              <ul class="max-w-[68ch] space-y-2.5">
                ${entry.limits.map((l, i) => html`
                  <li key=${i} class="relative pl-5 text-[16.5px] leading-[1.7]">
                    <span class="absolute left-0 top-[0.7em] h-px w-2.5 bg-muted" aria-hidden="true"></span><${Rich} text=${l} />
                  </li>`)}
              </ul>
            </${Section}>` : null}
        </div>
        <div class="space-y-4">
          ${entry.tests && entry.tests.length ? html`
            <${Disclosure} title=${`Tests (${entry.tests.length})`}>
              <ul class="space-y-1.5 text-[13.5px] text-muted">
                ${entry.tests.map((t, i) => html`<li key=${i} class="break-words"><${Name} text=${t} /></li>`)}
              </ul>
            </${Disclosure}>` : null}
          <${Disclosure} title="Full GitHub description"><${GitHubDescription} body=${pr.body} /></${Disclosure}>
        </div>` : html`
        <div class="space-y-4">
          <p class="text-sm text-muted">No write-up for this one yet. Here is the description from GitHub.</p>
          <${GitHubDescription} body=${pr.body} />
        </div>`}
    </div>`;
}

/* ---------- list rows ---------- */

function PRItem({ row, open, onToggle, group, onOpenPr }) {
  const { pr, status, entry } = row;
  const title = useMemo(() => parseTitle(pr.title), [pr.title]);
  const ref = useRef(null);
  const panelId = `pr-${pr.number}-panel`;
  const hasWriteUp = Boolean(entry && entry.why);
  useEffect(() => {
    if (open && ref.current && location.hash.includes(`pr=${pr.number}`)) {
      ref.current.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }, [open]);
  return html`
    <li ref=${ref} id=${`pr-${pr.number}`} class="scroll-mt-6 border-b border-line">
      <div class="flex items-start gap-3 sm:gap-5">
        <button type="button" class="group flex min-w-0 flex-1 items-start gap-3 py-6 text-left sm:gap-5"
          aria-expanded=${open} aria-controls=${panelId} onClick=${onToggle}>
          <span class="mt-[3px] hidden w-12 shrink-0 font-mono text-[13.5px] tabular-nums text-muted sm:block">#${pr.number}</span>
          <span class="min-w-0 flex-1">
            <span class="flex flex-wrap items-center gap-2">
              <${Tag} tag=${STATUS_META[status].tag} label=${STATUS_META[status].label} />
              <span class="font-mono text-[13px] text-muted sm:hidden">#${pr.number}</span>
              ${title.type && html`<span class="font-mono text-[13px] text-muted">${title.type}${title.scope ? `(${title.scope})` : ''}</span>`}
            </span>
            <span class="mt-2 block text-[18.5px] font-medium leading-snug tracking-[-0.01em] text-ink group-hover:text-accent">${title.text}</span>
            <span class="mt-1.5 block max-w-[68ch] text-[16px] leading-relaxed text-muted">
              ${hasWriteUp ? entry.summary : 'No write-up yet.'}
            </span>
          </span>
          <${PlusMinus} open=${open} />
        </button>
      </div>
      ${open && html`<div id=${panelId} class="pb-12 sm:pl-[4.25rem]"><${Detail} row=${row} title=${title} group=${group} onOpenPr=${onOpenPr} /></div>`}
    </li>`;
}

function PRList({ rows, openPr, toggle, groupOf, onOpenPr }) {
  return html`
    <ul class="border-t border-line">
      ${rows.map((r) => html`
        <${PRItem} key=${r.pr.number} row=${r} open=${openPr === r.pr.number}
          onToggle=${() => toggle(r.pr.number)} group=${groupOf(r.pr.number)} onOpenPr=${onOpenPr} />`)}
    </ul>`;
}

/* ---------- proposals ---------- */

// Comments are GitHub Discussions in this page's own repo (category "Proposals"), one thread per
// proposal, matched by the term "proposal-<id>". Nothing is posted to the Graphify repo.
const GISCUS = {
  repo: 'Deepjyoti-Sarmah/graphify-contributions',
  repoId: 'R_kgDOVGf2CQ',
  category: 'Proposals',
  categoryId: 'DIC_kwDOVGf2Cc4DIHr0',
};

function Comments({ term }) {
  const ref = useRef(null);
  const dark = useIsDark();
  const theme = dark ? 'dark_dimmed' : 'light';
  useEffect(() => {
    const host = ref.current;
    if (!host) return undefined;
    const s = document.createElement('script');
    const attrs = {
      src: 'https://giscus.app/client.js',
      'data-repo': GISCUS.repo,
      'data-repo-id': GISCUS.repoId,
      'data-category': GISCUS.category,
      'data-category-id': GISCUS.categoryId,
      'data-mapping': 'specific',
      'data-term': term,
      'data-strict': '1',
      'data-reactions-enabled': '1',
      'data-emit-metadata': '0',
      'data-input-position': 'top',
      'data-theme': theme,
      'data-lang': 'en',
      'data-loading': 'lazy',
      crossorigin: 'anonymous',
    };
    Object.entries(attrs).forEach(([k, v]) => s.setAttribute(k, v));
    s.async = true;
    host.appendChild(s);
    return () => { host.innerHTML = ''; };
  }, [term]);
  // Follow the page theme without reloading the thread.
  useEffect(() => {
    const frame = ref.current && ref.current.querySelector('iframe.giscus-frame');
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ giscus: { setConfig: { theme } } }, 'https://giscus.app');
    }
  }, [theme]);
  return html`<div ref=${ref} class="giscus min-h-[4rem]"></div>`;
}

function proposalIssueUrl(p, answer) {
  const title = `Proposal ${p.id}: ${answer}, ${p.title}`;
  const body = [
    `**Proposal:** ${p.title} (\`${p.id}\`)`,
    `**Answer:** ${answer}`,
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

function ProposalItem({ p }) {
  const [open, setOpen] = useState(false);
  const panelId = `proposal-${p.id}`;
  return html`
    <li class="border-b border-line">
      <button type="button" class="group flex w-full items-start gap-5 py-6 text-left" aria-expanded=${open} aria-controls=${panelId} onClick=${() => setOpen(!open)}>
        <span class="min-w-0 flex-1">
          <span class="flex flex-wrap items-center gap-2">
            <${Tag} tag=${RISK_TAG[p.risk] || 'tag-yellow'} label=${`Risk ${p.risk}`} />
            <${Tag} tag="tag-gray" label=${`Size ${p.size}`} />
          </span>
          <span class="mt-2 block text-[18.5px] font-medium leading-snug text-ink group-hover:text-accent">${p.title}</span>
          <span class="mt-1.5 block max-w-[68ch] text-[16px] leading-relaxed text-muted">${p.problem}</span>
        </span>
        <${PlusMinus} open=${open} />
      </button>
      ${open && html`
        <div id=${panelId} class="panel space-y-8 pb-12">
          <${Section} label="Evidence"><${Paragraph} text=${p.evidence} /></${Section}>
          ${p.diagram ? html`<${Section} label="Today vs proposed"><${Diagram} source=${p.diagram} caption=${p.title} /></${Section}>` : null}
          <${Section} label="Plan">
            <ol class="max-w-[68ch] space-y-2.5">
              ${p.plan.map((step, i) => html`
                <li key=${i} class="flex gap-3 text-[16.5px] leading-[1.7]">
                  <span class="mt-[3px] font-mono text-[13px] tabular-nums text-muted">${String(i + 1).padStart(2, '0')}</span><span><${Rich} text=${step} /></span>
                </li>`)}
            </ol>
          </${Section}>
          ${(p.related || []).length ? html`
            <${Section} label="Related">
              <p class="flex flex-wrap gap-3 text-sm">${p.related.map((n) => html`<a key=${n} class="link font-mono" href=${ISSUE_URL(n)} target="_blank" rel="noopener noreferrer">#${n}</a>`)}</p>
            </${Section}>` : null}
          <${Section} label="Your answer">
            <div class="flex flex-wrap gap-2">
              ${ANSWERS.map((a, i) => html`
                <a key=${a} href=${proposalIssueUrl(p, a)} target="_blank" rel="noopener noreferrer"
                  class=${i === 0
                    ? 'inline-flex h-9 items-center rounded-md bg-ink px-4 text-sm font-medium text-canvas transition-opacity hover:opacity-85'
                    : 'inline-flex h-9 items-center rounded-md border border-line bg-surface px-4 text-sm font-medium text-ink transition-colors hover:bg-subtle'}>${a}</a>`)}
            </div>
            <p class="mt-2 text-xs text-muted">Each button opens a GitHub issue draft with the proposal and your answer filled in. Nothing is saved on this page.</p>
          </${Section}>
          <${Section} label="Comments">
            <p class="mb-4 text-xs text-muted">Sign in with GitHub to comment. Comments are stored as a discussion in this page's repository, not in Graphify's.</p>
            <${Comments} term=${`proposal-${p.id}`} />
          </${Section}>
        </div>`}
    </li>`;
}

function Proposals({ items }) {
  if (!items.length) {
    return html`
      <div class="rounded-lg border border-dashed border-line px-6 py-10 text-center">
        <p class="text-sm font-medium">No proposals yet</p>
        <p class="mx-auto mt-1 max-w-[46ch] text-sm text-muted">Each proposal will name a problem, the evidence for it and a plan, with buttons to answer it on GitHub.</p>
      </div>`;
  }
  return html`<ul class="border-t border-line">${items.map((p) => html`<${ProposalItem} key=${p.id} p=${p} />`)}</ul>`;
}

/* ---------- page chrome ---------- */

function TopBar({ theme, refreshing, onRefresh }) {
  return html`
    <header class="border-b border-line">
      <div class="mx-auto flex h-14 max-w-4xl items-center justify-between px-4 sm:px-6">
        <a href=${`https://github.com/${REPO}`} target="_blank" rel="noopener noreferrer" class="font-mono text-[13.5px] text-muted hover:text-ink">${REPO}</a>
        <div class="flex items-center gap-1">
          <button type="button" class=${ICON_BUTTON} onClick=${onRefresh} disabled=${refreshing}
            aria-label="Reload from GitHub" title="Reload from GitHub">
            <span class=${refreshing ? 'animate-spin' : ''}><${IconRefresh} /></span>
          </button>
          <button type="button" class=${ICON_BUTTON} onClick=${theme.toggle}
            aria-label=${theme.dark ? 'Switch to light mode' : 'Switch to dark mode'} title=${theme.dark ? 'Light mode' : 'Dark mode'}>
            ${theme.dark ? html`<${IconSun} />` : html`<${IconMoon} />`}
          </button>
        </div>
      </div>
    </header>`;
}

function Intro({ counts, total, pulls, active, onPick }) {
  let updated = 'Loading from GitHub';
  if (pulls.failed) updated = 'Could not load';
  else if (pulls.at) updated = `${pulls.source === 'snapshot' ? 'Saved copy from' : 'Updated'} ${relativeTime(pulls.at)}`;
  const stats = [['open', 'open'], ['draft', 'draft'], ['merged', 'merged or landed'], ['closed', 'closed']];
  return html`
    <section class="pb-12 pt-14 sm:pt-20">
      <div class="flex items-center gap-3">
        <img src=${`https://github.com/${AUTHOR}.png?size=80`} alt="" width="32" height="32" class="h-8 w-8 rounded-full border border-line" />
        <a href=${`https://github.com/${AUTHOR}`} target="_blank" rel="noopener noreferrer" class="text-sm text-muted hover:text-ink">${AUTHOR}</a>
      </div>
      <h1 class="mt-6 font-serif text-[2.5rem] font-medium leading-[1.08] tracking-[-0.025em] sm:text-[3.25rem]">Pull requests to Graphify</h1>
      <p class="mt-5 max-w-[60ch] text-[18.5px] leading-[1.65] text-muted">
        Each one says what was broken, what the change does, and how it was tested. Status, CI and diff size come live from GitHub. Open any row to read it.
      </p>
      <div class="mt-8 flex flex-wrap items-center gap-x-1 gap-y-2 text-sm">
        <span class="mr-2 tabular-nums"><span class="font-medium">${total}</span> <span class="text-muted">total</span></span>
        ${stats.map(([key, label]) => html`
          <button key=${key} type="button" aria-pressed=${active === key} onClick=${() => onPick(key)}
            class=${`rounded-md px-2 py-1 tabular-nums transition-colors ${active === key ? 'bg-ink text-canvas' : 'hover:bg-subtle'}`}>
            <span class="font-medium">${counts[key]}</span> <span class=${active === key ? 'opacity-80' : 'text-muted'}>${label}</span>
          </button>`)}
        <span class="ml-auto text-xs text-muted">${updated}</span>
      </div>
    </section>`;
}

function Toolbar({ filters, update, groups }) {
  const tabs = ['all', ...STATUSES];
  return html`
    <div class="mb-2 flex flex-col gap-3 md:flex-row md:items-center">
      <label class="relative min-w-0 flex-1">
        <span class="sr-only">Search pull requests</span>
        <input type="search" class=${`${CONTROL} w-full`} placeholder="Search by title, number or summary" value=${filters.q}
          onInput=${(e) => update({ q: e.target.value })} />
      </label>
      <div class="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Filter by status" class="inline-flex h-9 items-center rounded-md border border-line bg-surface p-0.5">
          ${tabs.map((t) => html`
            <button key=${t} role="tab" type="button" aria-selected=${filters.status === t} onClick=${() => update({ status: t })}
              class=${`h-full whitespace-nowrap rounded px-2.5 text-[14px] transition-colors ${filters.status === t ? 'bg-subtle font-medium text-ink' : 'text-muted hover:text-ink'}`}>
              ${t === 'all' ? 'All' : (t === 'merged' ? 'Merged' : STATUS_META[t].label)}
            </button>`)}
        </div>
        <label>
          <span class="sr-only">Group</span>
          <select class=${CONTROL} value=${filters.g} onChange=${(e) => update({ g: e.target.value })}>
            <option value="all">All issues</option>
            ${groups.map((g) => html`<option key=${g.id} value=${g.id}>Issue #${g.issue}</option>`)}
            <option value="none">Not grouped</option>
          </select>
        </label>
        <label>
          <span class="sr-only">Sort</span>
          <select class=${CONTROL} value=${filters.sort} onChange=${(e) => update({ sort: e.target.value })}>
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="status">By status</option>
          </select>
        </label>
        <div class="inline-flex h-9 items-center rounded-md border border-line bg-surface p-0.5" role="group" aria-label="Layout">
          ${[['list', 'List'], ['grouped', 'By issue']].map(([value, label]) => html`
            <button key=${value} type="button" aria-pressed=${filters.view === value} onClick=${() => update({ view: value })}
              class=${`h-full whitespace-nowrap rounded px-2.5 text-[14px] transition-colors ${filters.view === value ? 'bg-subtle font-medium text-ink' : 'text-muted hover:text-ink'}`}>${label}</button>`)}
        </div>
      </div>
    </div>`;
}

function GroupSection({ section, children }) {
  const { group } = section;
  const headingId = `group-${section.key}`;
  return html`
    <section aria-labelledby=${headingId} class="pt-8">
      <div class="mb-4 max-w-[68ch]">
        ${group
          ? html`
            <a href=${ISSUE_URL(group.issue)} target="_blank" rel="noopener noreferrer" class="font-mono text-[13.5px] text-muted hover:text-ink">Issue #${group.issue}</a>
            <h3 id=${headingId} class="mt-1 font-serif text-xl font-medium leading-snug tracking-[-0.01em]">${group.title}</h3>`
          : html`<h3 id=${headingId} class="font-serif text-xl font-medium">Other pull requests</h3>`}
      </div>
      ${children}
    </section>`;
}

function Footer() {
  return html`
    <footer class="mt-24 border-t border-line">
      <div class="mx-auto flex max-w-4xl flex-col gap-2 px-4 py-8 text-xs text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>Write-ups come from <code class="font-mono">data.json</code>. Status comes from the GitHub API, with a saved copy if GitHub is unreachable.</p>
        <a href="#top" class="hover:text-ink" onClick=${(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Back to top</a>
      </div>
    </footer>`;
}

/* ---------- app ---------- */

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
  const togglePr = (n) => update({ pr: filters.pr === n ? null : n });
  // Opening a PR from a link clears filters that would hide it.
  const openPr = (n) => setFilters((f) => ({ ...f, status: 'all', q: '', g: 'all', pr: n }));

  const groupOf = useCallback((n) => (content ? content.groups.find((g) => g.prs.includes(n)) || null : null), [content]);

  const rows = useMemo(() => {
    if (!content || !pulls.items) return [];
    return pulls.items.map(normalize).map((pr) => {
      const entry = content.prs[String(pr.number)] || null;
      return { pr, entry, status: statusOf(pr, entry), group: groupOf(pr.number) };
    });
  }, [content, pulls.items, groupOf]);

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
      .map((g) => ({ key: g.id, group: g, rows: g.prs.map((n) => visible.find((r) => r.pr.number === n)).filter(Boolean) }))
      .filter((s) => s.rows.length);
    const loose = visible.filter((r) => !r.group);
    if (loose.length) out.push({ key: 'ungrouped', group: null, rows: loose });
    return out;
  }, [content, visible]);

  const listProps = { openPr: filters.pr, toggle: togglePr, groupOf, onOpenPr: openPr };

  let body;
  if (contentFailed || pulls.failed) {
    body = html`<p role="alert" class="rounded-lg border border-line bg-surface p-4 text-sm"><span class="bad-text font-medium">Could not load the pull requests.</span> <span class="text-muted">GitHub did not answer and the saved copy is missing.</span></p>`;
  } else if (pulls.loading || !content) {
    body = html`<div role="status" aria-label="Loading pull requests" class="border-t border-line">
      ${[0, 1, 2, 3].map((i) => html`
        <div key=${i} class="skeleton border-b border-line py-6">
          <div class="h-4 w-16 rounded-full bg-subtle"></div>
          <div class="mt-3 h-5 w-3/4 rounded bg-subtle"></div>
          <div class="mt-2 h-4 w-1/2 rounded bg-subtle"></div>
        </div>`)}
    </div>`;
  } else if (!visible.length) {
    body = html`
      <div class="rounded-lg border border-dashed border-line px-6 py-10 text-center text-sm">
        <p>No pull requests match these filters.</p>
        <button type="button" class="link mt-2" onClick=${() => setFilters({ ...DEFAULT_FILTERS })}>Clear filters</button>
      </div>`;
  } else if (filters.view === 'grouped') {
    body = html`<div>${sections.map((s) => html`<${GroupSection} key=${s.key} section=${s}><${PRList} rows=${s.rows} ...${listProps} /></${GroupSection}>`)}</div>`;
  } else {
    body = html`<${PRList} rows=${visible} ...${listProps} />`;
  }

  const snapshotDate = pulls.source === 'snapshot' ? dateOnly(new Date(pulls.at).toISOString()) : null;

  return html`
    <div id="top" class="min-h-screen">
      <a href="#prs" class="skip-link">Skip to the pull requests</a>
      <${TopBar} theme=${theme} refreshing=${refreshing} onRefresh=${() => load(true)} />
      <main class="mx-auto max-w-4xl px-4 sm:px-6">
        <${Intro} counts=${counts} total=${rows.length} pulls=${pulls} active=${filters.status} onPick=${toggleStatus} />

        ${snapshotDate && html`
          <p role="status" class="mb-6 rounded-lg bg-[#FBF3DB] px-4 py-3 text-sm text-[#6B4A00] dark:bg-[rgb(149_100_0/0.3)] dark:text-[#EBCB85]">
            Showing a saved copy from ${snapshotDate} (${pulls.reason}).
          </p>`}

        <section id="prs" aria-label="Pull requests" class="scroll-mt-6">
          <${Toolbar} filters=${filters} update=${update} groups=${content ? content.groups : []} />
          ${!pulls.loading && !pulls.failed && content && visible.length !== rows.length && html`
            <p class="mb-2 mt-4 text-xs text-muted">Showing ${visible.length} of ${rows.length}</p>`}
          <div class="mt-4">${body}</div>
        </section>

        <section aria-labelledby="proposals-heading" class="pt-24">
          <h2 id="proposals-heading" class="font-serif text-[2rem] font-medium leading-tight tracking-[-0.02em]">Proposals</h2>
          <p class="mb-8 mt-3 max-w-[60ch] text-[16.5px] leading-[1.7] text-muted">
            Work I would like to do next. Each one names the problem, the evidence and a plan, so you can say yes or no before any code is written.
          </p>
          ${content ? html`<${Proposals} items=${content.proposals || []} />` : null}
        </section>
      </main>
      <${Footer} />
    </div>`;
}

ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
