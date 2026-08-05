/**
 * Tiny, dependency-free HTML helpers for the admin UI. HTMX is included via
 * unpkg in the layout — no SPA build step, no client framework.
 */

export function escape(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export type TabId = 'jobs' | 'status' | 'models' | 'providers' | 'wallet' | 'stamps'
export interface NavTab {
  id: TabId
  href: string
  label: string
  /** Render as a muted, non-clickable span instead of a link. Used during
   *  onboarding to keep the nav visually consistent with normal mode while
   *  signalling that the tab isn't reachable yet. */
  disabled?: boolean
}

/** Default tab set for the provider admin (no "Providers" — provider doesn't
 *  serve a market-listing page). */
export const PROVIDER_TABS: NavTab[] = [
  {id: 'jobs', href: '/', label: 'Jobs'},
  {id: 'models', href: '/models', label: 'Models'},
  {id: 'wallet', href: '/wallet', label: 'Wallet'},
  {id: 'stamps', href: '/stamps', label: 'Stamps'},
  {id: 'status', href: '/status', label: 'Status'},
]

/** Default tab set for the client admin (includes "Providers" market view). */
export const GATEWAY_TABS: NavTab[] = [
  {id: 'jobs', href: '/', label: 'Jobs'},
  {id: 'models', href: '/models', label: 'Models'},
  {id: 'providers', href: '/providers', label: 'Providers'},
  {id: 'wallet', href: '/wallet', label: 'Wallet'},
  {id: 'stamps', href: '/stamps', label: 'Stamps'},
  {id: 'status', href: '/status', label: 'Status'},
]

export interface LayoutOpts {
  title: string
  refreshSeconds: number
  body: string
  active: TabId
  /** Tabs to render in the nav. Falls back to GATEWAY_TABS for backwards
   *  compatibility with callers that haven't been updated yet. */
  tabs?: NavTab[]
}

export function layout(opts: LayoutOpts): string {
  const tabs = opts.tabs ?? GATEWAY_TABS
  const tab = (t: NavTab) =>
    t.disabled
      ? `<span class="disabled">${escape(t.label)}</span>`
      : `<a href="${t.href}" class="${opts.active === t.id ? 'active' : ''}">${escape(t.label)}</a>`
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escape(opts.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700;800&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
  <script src="https://unpkg.com/htmx.org@1.9.12" integrity="sha384-ujb1lZYygJmzgSwoxRggbCHcjc0rB2XoQrxeTUQyRjrOnlCoYta87iKBWq3EsdM2" crossorigin="anonymous"></script>
  <style>
    :root{
      --bg:#0a0a0a; --bg-elev:#131313; --bg-deeper:#050505;
      --ink:#ededed; --ink-dim:#8a8a8a; --ink-faint:#4a4a4a;
      --line:#222; --line-strong:#333;
      --xbzz:#ff5c00; --xbzz-hot:#ff7424;
      --gnosis:#04795b; --swarm:#ffd400; --slash:#ff2d2d; --live:#00ff9c;
      --font-display:'JetBrains Mono',ui-monospace,monospace;
      --font-mono:'Space Mono',ui-monospace,monospace;
    }
    *,*::before,*::after{box-sizing:border-box}
    html,body{
      margin:0;padding:0;background:var(--bg);color:var(--ink);
      font:13px/1.5 var(--font-mono);
      -webkit-font-smoothing:antialiased;
    }
    /* Always fill the viewport so the tiled grid background paints to the
       bottom even on pages with little content. background-attachment fixed
       on its own respects body height, which can be shorter than the viewport. */
    html{min-height:100%}
    body{
      min-height:100vh;
      background-image:
        linear-gradient(var(--line) 1px,transparent 1px),
        linear-gradient(90deg,var(--line) 1px,transparent 1px);
      background-size:48px 48px;
      background-attachment:fixed;
    }
    a{color:var(--xbzz);text-decoration:none;border-bottom:1px dashed var(--xbzz)}
    a:hover{color:var(--xbzz-hot);border-color:var(--xbzz-hot)}

    header{
      background:var(--bg-deeper);
      border-bottom:1px solid var(--line-strong);
      padding:0 24px;display:flex;gap:0;align-items:stretch;
      position:sticky;top:0;z-index:10;
      min-height:46px;
    }
    header h1{
      margin:0;padding:14px 24px 14px 0;font-family:var(--font-display);
      font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
      color:var(--ink);align-self:center;
      border-right:1px solid var(--line-strong);
    }
    header h1::before{content:"▮ ";color:var(--xbzz)}
    header nav{display:flex;gap:0;align-items:stretch}
    header nav a{
      color:var(--ink-dim);text-decoration:none;border:none;
      padding:0 18px;display:inline-flex;align-items:center;
      font-family:var(--font-display);font-size:11px;font-weight:700;
      letter-spacing:.1em;text-transform:uppercase;
      border-right:1px solid var(--line-strong);
      transition:color 80ms linear,background 80ms linear;
    }
    header nav a:hover{color:var(--ink);background:var(--bg-elev)}
    header nav a.active{color:var(--ink);background:var(--bg-elev);box-shadow:inset 0 -2px 0 var(--xbzz)}
    header nav span.disabled{
      color:var(--ink-faint);padding:0 18px;display:inline-flex;align-items:center;
      font-family:var(--font-display);font-size:11px;font-weight:700;
      letter-spacing:.1em;text-transform:uppercase;
      border-right:1px solid var(--line-strong);
      cursor:not-allowed;opacity:.5;
    }
    header .pulse-flag{
      margin-left:auto;align-self:center;display:inline-flex;align-items:center;gap:8px;
      font-family:var(--font-display);font-size:10px;letter-spacing:.12em;
      text-transform:uppercase;color:var(--ink-dim);
    }
    header .pulse-flag::before{
      content:"";width:6px;height:6px;background:var(--live);
      box-shadow:0 0 8px var(--live);animation:t4tpulse 1.4s ease-in-out infinite;
    }
    @keyframes t4tpulse{0%,100%{opacity:1}50%{opacity:.3}}

    main{padding:24px;max-width:1280px;margin:0 auto;position:relative;z-index:2}

    section{
      background:var(--bg-elev);
      border:1px solid var(--line-strong);
      padding:20px;
      margin-bottom:16px;
    }
    section>:first-child{margin-top:0}
    section>:last-child{margin-bottom:0}

    h2{
      margin:0 0 14px;font-family:var(--font-display);
      font-size:12px;font-weight:700;letter-spacing:.1em;
      text-transform:uppercase;color:var(--ink);
      padding-bottom:10px;border-bottom:1px solid var(--line);
    }
    h3{
      margin:18px 0 10px;font-family:var(--font-display);
      font-size:12px;font-weight:700;letter-spacing:.08em;
      text-transform:uppercase;color:var(--ink);
    }
    p{margin:0 0 12px;color:var(--ink-dim);font-size:13px;line-height:1.6}
    strong{color:var(--ink);font-weight:700}

    pre{
      background:var(--bg-deeper)!important;
      border:1px solid var(--line-strong);
      padding:14px 16px!important;
      color:var(--ink);font-family:var(--font-mono);font-size:12px;
      overflow:auto;border-radius:0!important;margin:8px 0 14px;
    }
    code{
      background:var(--bg-deeper);padding:1px 5px;
      border:1px solid var(--line);color:var(--xbzz);font-size:12px;
    }

    table{
      width:100%;border-collapse:collapse;font-family:var(--font-mono);font-size:13px;
    }
    th,td{
      text-align:left;padding:10px 16px;
      border-bottom:1px solid var(--line);vertical-align:top;
    }
    th{
      font-family:var(--font-display);font-weight:700;font-size:10px;
      text-transform:uppercase;letter-spacing:.12em;color:var(--ink-faint);
      background:var(--bg-deeper);border-bottom:1px solid var(--line-strong);
    }
    tbody tr:last-child td{border-bottom:none}
    tbody tr:hover td{background:rgba(255,92,0,.03)}

    .mono{font-family:var(--font-mono);font-size:12px}

    .pill{
      display:inline-flex;align-items:center;gap:5px;
      font-family:var(--font-display);font-size:10px;font-weight:700;
      letter-spacing:.12em;text-transform:uppercase;
      padding:3px 8px;border:1px solid currentColor;
      background:var(--bg-deeper);
    }
    .pill::before{content:"";width:5px;height:5px;background:currentColor}
    .pill-queued,.pill-posted{color:var(--ink-dim)}
    .pill-running,.pill-acked{color:var(--swarm)}
    .pill-delivered{color:var(--live)}
    .pill-claimed{color:var(--gnosis)}
    .pill-failed,.pill-cancelled,.pill-timed_out{color:var(--slash)}

    .kv{
      display:grid;grid-template-columns:max-content 1fr;
      gap:8px 24px;font-size:13px;margin:0 0 4px;
    }
    .kv dt{
      color:var(--ink-faint);font-family:var(--font-display);
      font-size:10px;letter-spacing:.12em;text-transform:uppercase;
      align-self:center;
    }
    .kv dd{margin:0;font-family:var(--font-mono);color:var(--ink);font-size:13px;align-self:center}

    .ok{color:var(--live)}
    .warn{color:var(--swarm)}
    .err{color:var(--slash)}
    .muted{color:var(--ink-dim)}

    .notice{
      padding:12px 16px;margin:0 0 16px;
      background:rgba(255,212,0,.08);
      border:1px solid var(--swarm);
      color:var(--ink);font-size:13px;
    }
    .notice strong{color:var(--swarm)}

    .grid2{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
    @media(max-width:800px){.grid2{grid-template-columns:1fr}}

    textarea,input[type=text]{
      width:100%;font:13px/1.5 var(--font-mono);padding:9px 12px;
      background:var(--bg-deeper);border:1px solid var(--line-strong);
      color:var(--ink);outline:none;
    }
    textarea:focus,input[type=text]:focus{border-color:var(--xbzz)}
    textarea::placeholder,input[type=text]::placeholder{color:var(--ink-faint)}

    button{
      font-family:var(--font-display);font-size:11px;font-weight:700;
      letter-spacing:.1em;text-transform:uppercase;
      padding:8px 16px;border:1px solid var(--ink);
      background:transparent;color:var(--ink);
      cursor:pointer;transition:all 80ms linear;margin-top:8px;
    }
    button:hover{background:var(--ink);color:var(--bg)}

    .mnemonic{
      padding:18px;background:var(--bg-deeper);
      border:1px solid var(--swarm);
      font:16px/1.9 var(--font-mono);
      margin:8px 0 14px;word-spacing:8px;color:var(--swarm);
    }
    label.inline{
      display:flex;align-items:center;gap:8px;
      margin:10px 0;font-size:12px;color:var(--ink-dim);
    }

    form{margin:0}

    /* toasts */
    .toast-stack{
      position:fixed;top:62px;right:16px;
      display:flex;flex-direction:column;gap:8px;z-index:1000;pointer-events:none;
    }
    .toast{
      background:var(--bg-elev);color:var(--ink);
      border:1px solid var(--line-strong);
      border-left:3px solid var(--xbzz);
      padding:12px 16px;min-width:300px;font-size:12px;
      pointer-events:auto;animation:toastIn .2s ease-out;
      font-family:var(--font-mono);
    }
    .toast a{color:var(--xbzz);border:none;text-decoration:underline}
    .toast .kind{
      font-family:var(--font-display);font-weight:700;letter-spacing:.12em;
      text-transform:uppercase;font-size:10px;display:block;margin-bottom:4px;color:var(--xbzz);
    }
    .toast .hash,.toast .note{font-family:var(--font-mono);font-size:11px;color:var(--ink-dim)}
    @keyframes toastIn{from{transform:translateX(24px);opacity:0}to{transform:translateX(0);opacity:1}}
    .price-hint{font-size:12px;line-height:1.5;margin-top:6px;color:var(--ink);letter-spacing:.02em;font-weight:500}
    .price-hint span{display:inline-block}
    .price-hint span+span{color:var(--xbzz)}
    .price-hint.err{color:var(--slash)}
  </style>
</head>
<body>
  <header>
    <h1>${escape(opts.title)}</h1>
    <nav>
      ${tabs.map(tab).join('\n      ')}
    </nav>
    <span class="pulse-flag">Network Live</span>
  </header>
  <main hx-target="this" hx-swap="innerHTML">
    ${opts.body}
  </main>
  <div class="toast-stack" id="toast-stack"></div>
  <script>
  (() => {
    if (window.__t4tToastInit) return; window.__t4tToastInit = true;
    const stack = document.getElementById('toast-stack');
    // Start "now" so we don't replay the entire on-chain history on page load.
    let since = Math.floor(Date.now() / 1000);
    function shorthex(h){ return h && h.length > 12 ? h.slice(0,8) + '…' + h.slice(-4) : (h||''); }
    // Built with DOM nodes rather than innerHTML: the note carries on-chain
    // strings (model ids) and the hash lands in an href, so string-splicing
    // them would be an injection sink for anything the chain can hold.
    function el(tag, cls, text){
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = String(text);
      return n;
    }
    function show(t){
      const div = el('div', 'toast');
      div.appendChild(el('span', 'kind', 'TX · ' + t.kind));
      const a = el('a', 'hash', shorthex(t.hash));
      a.href = /^0x[0-9a-fA-F]{64}$/.test(String(t.hash || '')) ? 'https://gnosisscan.io/tx/' + t.hash : '#';
      a.target = '_blank'; a.rel = 'noopener';
      div.appendChild(a);
      if (t.note) div.appendChild(el('div', 'note', t.note));
      stack.appendChild(div);
      setTimeout(() => { div.style.transition='opacity .3s'; div.style.opacity='0'; }, 5500);
      setTimeout(() => div.remove(), 6000);
    }
    async function poll(){
      try {
        const r = await fetch('/events/tx?since=' + since, {cache:'no-store'});
        if (r.ok) {
          const d = await r.json();
          // listTransactions returns DESC; render oldest first so toasts stack chronologically.
          for (const t of (d.txs || []).slice().reverse()) show(t);
          since = d.now || since;
        }
      } catch {}
      setTimeout(poll, 3000);
    }
    poll();
  })();
  </script>
</body>
</html>`
}

export function statusPill(status: string): string {
  return `<span class="pill pill-${escape(status)}">${escape(status)}</span>`
}

export function shortHex(h: string, len = 10): string {
  if (!h) return ''
  return h.length <= len + 2 ? h : `${h.slice(0, 6)}…${h.slice(-4)}`
}

// xBZZ has 16 decimals on Gnosis (NOT 18). xDAI uses native 18.
const XBZZ_DECIMALS = 16n
const XDAI_DECIMALS = 18n

function formatWei(weiStr: string | bigint | null | undefined, decimals: bigint): string {
  if (weiStr === null || weiStr === undefined) return '—'
  const wei = typeof weiStr === 'bigint' ? weiStr : BigInt(weiStr)
  const scale = 10n ** decimals
  const whole = wei / scale
  const frac = wei % scale
  if (frac === 0n) return `${whole}`
  const fracStr = (frac + scale).toString().slice(1).replace(/0+$/, '')
  return `${whole}.${fracStr.slice(0, 6)}`
}

export function formatXBZZ(weiStr: string | bigint | null | undefined): string {
  return formatWei(weiStr, XBZZ_DECIMALS)
}

export function formatXdai(weiStr: string | bigint | null | undefined): string {
  return formatWei(weiStr, XDAI_DECIMALS)
}

/** Parse a decimal-BZZ string (e.g. "0.3", "1.5", "0") into PLUR (raw wei).
 *  PLUR is the smallest unit of BZZ — 1 BZZ = 10^16 PLUR. We do string math
 *  to avoid float precision loss: a value like "0.000000000001" can't survive
 *  Number(). Throws on non-decimal input or more than 16 fractional digits. */
export function parseBzzToPlur(input: string): bigint {
  const s = input.trim()
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(s)) throw new Error(`not a decimal: "${input}"`)
  const [wholeRaw = '0', fracRaw = ''] = s.split('.')
  if (fracRaw.length > 16) throw new Error(`too many fractional digits (max 16 for BZZ): "${input}"`)
  const whole = wholeRaw || '0'
  const fracPadded = (fracRaw + '0000000000000000').slice(0, 16)
  return BigInt(whole + fracPadded)
}

export function formatTs(ts: number | bigint | null | undefined): string {
  if (ts === null || ts === undefined) return '—'
  const n = typeof ts === 'bigint' ? Number(ts) : ts
  if (n === 0) return '—'
  return new Date(n * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

export function formatDuration(start: number | null, end: number | null): string {
  if (!start || !end) return '—'
  const s = end - start
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}
