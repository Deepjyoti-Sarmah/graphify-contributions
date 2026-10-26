#!/usr/bin/env bash
# Render every Mermaid source in data.json with the same Mermaid the page loads and the
# same settings index.html uses, so a diagram that would show "Diagram could not be
# rendered" is caught before it ships.
#
#   ./scripts/check-diagrams.sh
#
# Needs python3, curl-free, and a headless Chrome. It looks for chromium, google-chrome
# or the puppeteer download cache; set CHROME=/path/to/chrome to point at another one.
# Exit 0 when every diagram renders, 1 when one does not, 2 when it cannot run.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

port="${PORT:-8791}"
harness=".check-diagrams.html"
out="$(mktemp)"
trap 'rm -f "$harness" "$out"; [[ -n "${server_pid:-}" ]] && kill "$server_pid" 2>/dev/null || true' EXIT

# --- find a browser -------------------------------------------------------------------
chrome="${CHROME:-}"
if [[ -z "$chrome" ]]; then
  for c in chromium chromium-browser google-chrome google-chrome-stable; do
    if command -v "$c" >/dev/null 2>&1; then chrome="$(command -v "$c")"; break; fi
  done
fi
if [[ -z "$chrome" && -d "$HOME/.cache/puppeteer" ]]; then
  chrome="$(find "$HOME/.cache/puppeteer" -maxdepth 4 -type f \
            \( -name chrome -o -name chrome-headless-shell \) 2>/dev/null | head -1 || true)"
fi
if [[ -z "$chrome" || ! -x "$chrome" ]]; then
  echo "check-diagrams: no headless Chrome found. Set CHROME=/path/to/chrome." >&2
  exit 2
fi

# --- use whatever Mermaid the page loads ----------------------------------------------
mermaid_url="$(grep -o 'https://[^"]*mermaid[^"]*\.js' index.html | head -1 || true)"
if [[ -z "$mermaid_url" ]]; then
  echo "check-diagrams: no Mermaid script tag in index.html." >&2
  exit 2
fi

cat > "$harness" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<pre id="out">running</pre>
<script src="__MERMAID__"></script>
<script>
(async () => {
  const out = [];
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
  const d = await (await fetch('data.json')).json();
  const jobs = [];
  for (const [n, e] of Object.entries(d.prs || {})) {
    if (e.diagram) jobs.push([`prs[${n}].diagram`, e.diagram]);
    if (e.sequence) jobs.push([`prs[${n}].sequence`, e.sequence]);
  }
  for (const p of (d.proposals || [])) if (p.diagram) jobs.push([`proposal[${p.id}].diagram`, p.diagram]);
  let failed = 0;
  let i = 0;
  for (const [name, src] of jobs) {
    i += 1;
    try {
      const { svg } = await mermaid.render(`mmd${i}`, src);
      if (!svg || !svg.includes('<svg')) throw new Error('no svg produced');
      out.push('ok   ' + name);
    } catch (err) {
      failed += 1;
      out.push('FAIL ' + name + ' :: ' + String((err && err.message) || err).split('\n')[0].slice(0, 160));
    }
  }
  out.unshift(`rendered ${jobs.length}, failed ${failed}`);
  document.getElementById('out').textContent = out.join('\n');
})();
</script>
HTML

python3 - "$harness" "$mermaid_url" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
p.write_text(p.read_text().replace("__MERMAID__", sys.argv[2]))
PY

# --- serve the folder, because the page fetches data.json ---------------------------------
python3 -m http.server "$port" --bind 127.0.0.1 >/dev/null 2>&1 &
server_pid=$!
for _ in $(seq 1 100); do
  if python3 -c "
import socket, sys
s = socket.socket()
sys.exit(0 if s.connect_ex(('127.0.0.1', $port)) == 0 else 1)" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

"$chrome" --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --virtual-time-budget=120000 --dump-dom "http://127.0.0.1:$port/$harness" > "$out" 2>/dev/null

python3 - "$out" <<'PY'
import html, re, sys
dom = open(sys.argv[1], encoding="utf-8", errors="replace").read()
m = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
if not m:
    print("check-diagrams: the page did not finish; is the CDN reachable?", file=sys.stderr)
    sys.exit(2)
report = html.unescape(m.group(1))
lines = report.split("\n")
bad = [l for l in lines if l.startswith("FAIL")]
print(report if bad else (lines[0] if lines else report))
sys.exit(1 if bad else 0)
PY
