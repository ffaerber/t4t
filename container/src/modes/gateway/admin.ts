import express from 'express'
import {parseUnits, type Address} from 'viem'
import type {Bee} from '@ethersphere/bee-js'
import type {ChainClient} from '../../lib/chain'
import {sendXbzz, sendXdai} from '../../lib/chain'
import type {GatewayJobRow, JobsDb} from '../../lib/jobs-db'
import type {Logger} from '../../lib/logger'
import type {ModelDiscovery} from './models'
import type {OpenAIChatRequest, OpenAIChatResponse, ProgressEvent} from '../../lib/types'
import {attachClientApi} from './server'
import {
  GATEWAY_TABS,
  escape,
  formatTs,
  formatXBZZ,
  formatXdai,
  layout,
  shortHex,
  statusPill,
} from '../../lib/admin-html'
import {attachStampsAdmin, renderStampsPage} from '../../lib/admin-stamps'
import {getBzzUsd} from '../../lib/bzz-price'

export interface GatewayAdminDeps {
  host: string
  port: number
  statusRefreshSeconds: number
  payloadsPersisted: boolean
  db: JobsDb
  chain: ChainClient
  bee: Bee
  /** Resolved postage batch ID used for every Swarm upload. */
  postageBatchId: string
  /** True when T4T_STAMP_MANAGE=true and the container is auto-managing the batch. */
  stampManaged: boolean
  /** True when T4T_STAMP_DRY_RUN=true — disables top-up/dilute buttons. */
  stampDryRun: boolean
  /** Operator's intended TTL (days) — used as the default for the top-up input. */
  stampTtlDays: number
  discovery: ModelDiscovery
  pendingCount: () => number
  /** Enable OpenAI-style "fake" SSE streaming on /v1/chat/completions. */
  fakeStreaming: boolean
  /** OpenAI handler: posts the t4t job and returns the completion. The
   *  optional `onProgress` callback receives lifecycle events as the request
   *  moves through provider selection, on-chain posting, and PSS delivery. */
  handleChat: (
    req: OpenAIChatRequest,
    onProgress?: (e: ProgressEvent) => void,
  ) => Promise<OpenAIChatResponse>
  /** OpenAI handler: returns the discovered model union. */
  listModels: () => Promise<Array<{id: string; object: 'model'; created: number; owned_by: string}>>
  logger: Logger
}

export function startAdminServer(deps: GatewayAdminDeps): void {
  const app = express()

  // Mount the OpenAI-compatible API (/v1/*) on the same Express instance so
  // operator UI and SDK consumers share one port.
  attachClientApi(app, {
    logger: deps.logger,
    fakeStreaming: deps.fakeStreaming,
    handleChat: deps.handleChat,
    listModels: deps.listModels,
  })

  app.get('/healthz', (_req, res) => res.json({ok: true}))

  // Polled by the toast widget in every page. Returns transactions submitted
  // after `?since=<unix>` so the JS can render a notification for each new one.
  app.get('/events/tx', (req, res) => {
    const since = Number(req.query.since ?? 0)
    const txs = deps.db.listTransactions({sinceSeconds: since, limit: 20})
    res.json({txs, now: Math.floor(Date.now() / 1000)})
  })

  app.get('/', (_req, res) => {
    const rows = deps.db.listGatewayJobs({limit: 200})
    res.send(
      layout({
        title: 't4t gateway',
        refreshSeconds: 3,
        active: 'jobs', tabs: GATEWAY_TABS,
        body: jobsPage(rows, deps.db.totalSpentXBZZ(), deps.pendingCount(), deps.payloadsPersisted),
      }),
    )
  })

  app.get('/jobs/rows', (_req, res) => {
    const rows = deps.db.listGatewayJobs({limit: 200})
    res.send(jobsTableBody(rows, deps.payloadsPersisted))
  })

  app.get('/status', async (_req, res) => {
    const status = await collectStatus(deps).catch(err => ({err: String(err)} as Record<string, unknown>))
    res.send(
      layout({
        title: 't4t gateway',
        refreshSeconds: deps.statusRefreshSeconds,
        active: 'status', tabs: GATEWAY_TABS,
        body: statusPage(status, deps.statusRefreshSeconds),
      }),
    )
  })

  app.get('/status/panel', async (_req, res) => {
    const status = await collectStatus(deps).catch(err => ({err: String(err)} as Record<string, unknown>))
    res.send(statusPanels(status))
  })

  app.get('/models', async (_req, res) => {
    const [models, bzzUsd] = await Promise.all([
      deps.discovery.list().catch(() => []),
      getBzzUsd(deps.logger),
    ])
    res.send(
      layout({
        title: 't4t gateway',
        refreshSeconds: deps.statusRefreshSeconds,
        active: 'models', tabs: GATEWAY_TABS,
        body: modelsPage(models, bzzUsd),
      }),
    )
  })

  app.get('/providers', async (_req, res) => {
    const [providers, bzzUsd] = await Promise.all([
      deps.discovery.listProviders().catch(() => []),
      getBzzUsd(deps.logger),
    ])
    res.send(
      layout({
        title: 't4t gateway',
        refreshSeconds: deps.statusRefreshSeconds,
        active: 'providers', tabs: GATEWAY_TABS,
        body: providersPage(providers, bzzUsd),
      }),
    )
  })

  const stampsCfg = {
    bee: deps.bee,
    postageBatchId: deps.postageBatchId,
    managed: deps.stampManaged,
    dryRun: deps.stampDryRun,
    defaultTopUpDays: deps.stampTtlDays,
    logger: deps.logger,
  }
  attachStampsAdmin(app, stampsCfg)

  app.get('/stamps', (_req, res) => {
    res.send(
      layout({
        title: 't4t gateway',
        refreshSeconds: 0,
        active: 'stamps', tabs: GATEWAY_TABS,
        body: renderStampsPage(stampsCfg),
      }),
    )
  })

  app.get('/wallet', async (req, res) => {
    res.send(
      layout({
        title: 't4t gateway',
        refreshSeconds: deps.statusRefreshSeconds,
        active: 'wallet', tabs: GATEWAY_TABS,
        body: await walletPage(deps, req.query as Record<string, string>),
      }),
    )
  })

  app.post('/wallet/send', express.urlencoded({extended: false}), async (req, res) => {
    const body = req.body as {token?: string; to?: string; amount?: string}
    const token = body.token === 'xbzz' ? 'xbzz' : 'xdai'
    const to = (body.to ?? '').trim()
    const amountStr = (body.amount ?? '').trim()
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
      return res.redirect('/wallet?error=' + encodeURIComponent('invalid recipient address'))
    }
    let amountWei: bigint
    try {
      amountWei = parseUnits(amountStr, token === 'xdai' ? 18 : 16)
    } catch {
      return res.redirect('/wallet?error=' + encodeURIComponent('invalid amount'))
    }
    if (amountWei <= 0n) {
      return res.redirect('/wallet?error=' + encodeURIComponent('amount must be > 0'))
    }
    try {
      const hash = token === 'xdai'
        ? await sendXdai(deps.chain, to as Address, amountWei)
        : await sendXbzz(deps.chain, to as Address, amountWei)
      deps.logger.info({token, to, amountWei: amountWei.toString(), hash}, 'wallet send submitted')
      return res.redirect(`/wallet?sent=${hash}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      deps.logger.warn({err, token, to}, 'wallet send failed')
      return res.redirect('/wallet?error=' + encodeURIComponent(msg))
    }
  })

  app.listen(deps.port, deps.host, () =>
    deps.logger.info({host: deps.host, port: deps.port}, 'admin ui listening'),
  )
}

function jobsPage(rows: GatewayJobRow[], spent: bigint, pending: number, payloads: boolean): string {
  const success = rows.filter(r => r.status === 'delivered' || r.status === 'claimed').length
  const rate = rows.length === 0 ? '—' : `${Math.round((success * 100) / rows.length)}%`
  return `
<section>
  <h2>Summary</h2>
  <dl class="kv">
    <dt>Total spent</dt><dd>${escape(formatXBZZ(spent))} xBZZ</dd>
    <dt>In-flight</dt><dd>${escape(pending)}</dd>
    <dt>Success rate (7d)</dt><dd>${escape(rate)}</dd>
    <dt>Payload persistence</dt><dd class="${payloads ? 'warn' : 'muted'}">${payloads ? 'on' : 'off (default)'}</dd>
  </dl>
</section>
<section>
  <h2>Jobs (last 7d)</h2>
  <table>
    <thead><tr>
      <th>Job</th><th>Provider</th><th>Model</th><th>Status</th>
      <th>Posted</th><th>Max xBZZ <span class="muted">(escrow)</span></th><th>Paid xBZZ <span class="muted">(actual)</span></th><th>AI Token (input/output)</th>
      <th>Prompt</th><th>Error</th>
    </tr></thead>
    <tbody hx-get="/jobs/rows" hx-trigger="every 3s" hx-target="this" hx-swap="innerHTML">
      ${jobsTableBody(rows, payloads)}
    </tbody>
  </table>
  <p class="muted" style="font-size:11px;margin-top:8px">
    <strong>Max xBZZ</strong> is the worst-case amount escrowed at <code>postJob</code> (price &times; 1M-token cap).
    <strong>Paid xBZZ</strong> is what the provider actually claimed for the tokens used; the escrow refunds the
    difference back to this wallet in the same <code>claimJob</code> tx. Older rows show — for Paid because they
    pre-date the on-chain claim watcher (see note in /wallet).
  </p>
</section>`
}

function jobsTableBody(rows: GatewayJobRow[], payloads: boolean): string {
  if (rows.length === 0) return `<tr><td colspan="10" class="muted">No jobs yet.</td></tr>`
  return rows
    .map(
      r => `<tr>
      <td class="mono">${escape(shortHex(r.jobId))}</td>
      <td class="mono">${escape(shortHex(r.provider))}</td>
      <td>${escape(r.modelId)}</td>
      <td>${statusPill(r.status)}</td>
      <td>${escape(formatTs(r.postedAt))}</td>
      <td>${escape(formatXBZZ(r.maxPayment))}</td>
      <td>${escape(formatXBZZ(r.actualPayment))}</td>
      <td>${escape(r.promptTokens ?? '—')} / ${escape(r.completionTokens ?? '—')}</td>
      <td>${escape((payloads && r.prompt ? r.prompt.slice(0, 80) : r.prompt) ?? '')}</td>
      <td class="err">${escape(r.errorMessage ?? '')}</td>
    </tr>`,
    )
    .join('')
}

function statusPage(status: Record<string, unknown>, refreshSec: number): string {
  return `
<section>
  <h2>Live status (refreshes every ${refreshSec}s)</h2>
  <div hx-get="/status/panel" hx-trigger="every ${refreshSec}s" hx-target="this" hx-swap="innerHTML">
    ${statusPanels(status)}
  </div>
</section>`
}

function statusPanels(s: Record<string, unknown>): string {
  if (s.err) return `<p class="err">${escape(s.err)}</p>`
  const bee = s.bee as {url: string; ok: boolean; overlay?: string; postageBatchId?: string} | undefined
  const chain = s.chain as {chainId?: number; block?: bigint; gasBalance?: bigint; xbzzBalance?: bigint} | undefined
  const role = s.role as {pending?: number; lastSuccess?: number} | undefined
  return `
<div class="grid2">
  <section>
    <h2>Bee</h2>
    <dl class="kv">
      <dt>API URL</dt><dd>${escape(bee?.url ?? '')}</dd>
      <dt>Reachable</dt><dd class="${bee?.ok ? 'ok' : 'err'}">${bee?.ok ? 'yes' : 'no'}</dd>
      <dt>Overlay</dt><dd>${escape(bee?.overlay ?? '—')}</dd>
      <dt>Postage batch</dt><dd class="mono">${
        bee?.postageBatchId
          ? `<a href="https://batch-explorer.github.io/batch/${escape(bee.postageBatchId)}" target="_blank" rel="noopener">${escape(bee.postageBatchId)}</a>`
          : '—'
      }</dd>
    </dl>
  </section>
  <section>
    <h2>Gnosis Chain</h2>
    <dl class="kv">
      <dt>Chain id</dt><dd>${escape(chain?.chainId ?? '—')}</dd>
      <dt>Block</dt><dd>${escape(chain?.block?.toString() ?? '—')}</dd>
      <dt>xDAI (gas)</dt><dd>${escape(formatXdai(chain?.gasBalance ?? null))}</dd>
      <dt>xBZZ balance</dt><dd>${escape(formatXBZZ(chain?.xbzzBalance ?? null))}</dd>
    </dl>
  </section>
  <section>
    <h2>Client role</h2>
    <dl class="kv">
      <dt>Pending jobs</dt><dd>${escape(role?.pending ?? '—')}</dd>
      <dt>Last success</dt><dd>${escape(formatTs(role?.lastSuccess ?? null))}</dd>
    </dl>
  </section>
</div>`
}

function priceCell(plur: bigint, bzzUsd: number | null): string {
  const bzz = formatXBZZ(plur)
  if (bzzUsd == null) return `<span class="mono">${escape(bzz)}</span> BZZ`
  const usd = (Number(plur) / 1e16) * bzzUsd
  const usdFmt = usd >= 1 ? usd.toFixed(4) : usd >= 0.0001 ? usd.toFixed(6) : usd.toExponential(2)
  return `<span class="mono">${escape(bzz)}</span> BZZ<br><span class="muted mono">${escape(usdFmt)} USD</span>`
}

function modelsPage(
  models: import('./models').ModelSummary[],
  bzzUsd: number | null,
): string {
  const usdBadge = bzzUsd
    ? `<span class="mono">1 BZZ ≈ ${bzzUsd.toFixed(4)} USD</span> <span class="muted">(<a href="https://www.coingecko.com/en/coins/swarm" target="_blank" rel="noopener">CoinGecko</a>, 5m cache)</span>`
    : `<span class="muted">USD price unavailable</span>`
  const body = models.length === 0
    ? `<tr><td colspan="7" class="muted">No models discovered yet.</td></tr>`
    : models
        .map(
          m => `<tr>
        <td class="mono">${escape(m.id)}</td>
        <td>${escape(m.providerCount)}</td>
        <td>${priceCell(m.minInputPrice, bzzUsd)}</td>
        <td>${priceCell(m.medianInputPrice, bzzUsd)}</td>
        <td>${priceCell(m.minOutputPrice, bzzUsd)}</td>
        <td>${priceCell(m.medianOutputPrice, bzzUsd)}</td>
        <td>${escape(m.slowestSlaSeconds)}s</td>
      </tr>`,
        )
        .join('')
  return `
<section>
  <h2>Discovered models</h2>
  <p class="muted">
    Per 1,000,000 AI tokens. Input = prompt AI tokens, output = completion AI tokens. ${usdBadge}
  </p>
  <table>
    <thead><tr>
      <th>Model</th><th>Providers</th><th>Min in / 1M</th><th>Median in / 1M</th><th>Min out / 1M</th><th>Median out / 1M</th><th>Slowest SLA</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>
</section>`
}

function providersPage(
  providers: import('./models').ProviderListing[],
  bzzUsd: number | null,
): string {
  if (providers.length === 0) {
    return `<section><h2>Providers</h2><p class="muted">No live providers discovered yet.</p></section>`
  }
  const usdBadge = bzzUsd
    ? `<span class="mono">1 BZZ ≈ ${bzzUsd.toFixed(4)} USD</span> <span class="muted">(<a href="https://www.coingecko.com/en/coins/swarm" target="_blank" rel="noopener">CoinGecko</a>, 5m cache)</span>`
    : `<span class="muted">USD price unavailable</span>`
  const sections = providers
    .map(({provider: p, offerings}) => {
      const successRate = p.totalJobs === 0 ? '—' : `${Math.round((p.successfulJobs * 100) / p.totalJobs)}%`
      const rows = offerings
        .map(
          o => `<tr>
        <td class="mono">${escape(o.modelId)}</td>
        <td>${priceCell(o.inputPricePerMillionTokens, bzzUsd)}</td>
        <td>${priceCell(o.outputPricePerMillionTokens, bzzUsd)}</td>
        <td>${escape(o.maxLatencySeconds)}s</td>
        <td>${o.maxContextTokens === 0n ? '<span class="muted">—</span>' : escape(o.maxContextTokens)}</td>
      </tr>`,
        )
        .join('')
      return `
<section>
  <h2 class="mono">${escape(p.owner)}</h2>
  <dl class="kv">
    <dt>Stake</dt><dd>${escape(formatXBZZ(p.stake))} BZZ</dd>
    <dt>Jobs (success / total)</dt><dd>${escape(p.successfulJobs)} / ${escape(p.totalJobs)} (${escape(successRate)})</dd>
    <dt>Last heartbeat</dt><dd>${escape(formatTs(p.lastHeartbeat))}</dd>
  </dl>
  <table>
    <thead><tr>
      <th>Model</th><th>Input / 1M AI tokens</th><th>Output / 1M AI tokens</th><th>SLA</th><th>Max ctx</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`
    })
    .join('')
  return `
<section>
  <h2>Live providers</h2>
  <p class="muted">Active, heartbeat-fresh providers. Prices per 1,000,000 AI tokens. ${usdBadge}</p>
</section>
${sections}`
}

async function collectStatus(deps: GatewayAdminDeps): Promise<Record<string, unknown>> {
  const beeUrl = (deps.bee as unknown as {url?: string}).url ?? ''
  const [beeOk, overlay, block, gasBalance, xbzzBalance] = await Promise.all([
    deps.bee
      .getNodeAddresses()
      .then(() => true)
      .catch(() => false),
    deps.bee
      .getNodeAddresses()
      .then(a => a.overlay?.toString())
      .catch(() => undefined),
    deps.chain.pub.getBlockNumber().catch(() => undefined),
    deps.chain.pub.getBalance({address: deps.chain.address}).catch(() => undefined),
    deps.chain.pub
      .readContract({
        address: deps.chain.xbzz,
        abi: [
          {
            type: 'function',
            name: 'balanceOf',
            stateMutability: 'view',
            inputs: [{name: 'o', type: 'address'}],
            outputs: [{type: 'uint256'}],
          },
        ],
        functionName: 'balanceOf',
        args: [deps.chain.address],
      })
      .catch(() => undefined),
  ])
  const lastSuccess = deps.db.lastGatewaySuccessAt() ?? undefined
  return {
    bee: {url: beeUrl, ok: beeOk, overlay, postageBatchId: deps.postageBatchId},
    chain: {chainId: deps.chain.pub.chain?.id, block, gasBalance, xbzzBalance},
    role: {pending: deps.pendingCount(), lastSuccess},
  }
}

async function walletPage(deps: GatewayAdminDeps, query: Record<string, string> = {}): Promise<string> {
  const address = deps.chain.address
  const [gas, xbzz] = await Promise.all([
    deps.chain.pub.getBalance({address}).catch(() => undefined),
    deps.chain.pub
      .readContract({
        address: deps.chain.xbzz,
        abi: [
          {
            type: 'function',
            name: 'balanceOf',
            stateMutability: 'view',
            inputs: [{name: 'o', type: 'address'}],
            outputs: [{type: 'uint256'}],
          },
        ],
        functionName: 'balanceOf',
        args: [address],
      })
      .catch(() => undefined),
  ])
  const txs = deps.db.listTransactions({limit: 100})
  const empty = !gas || gas === 0n || !xbzz || xbzz === 0n
  const fundingBanner = empty
    ? `<p class="notice"><strong>Wallet needs funding.</strong> Send roughly <strong>0.5 xDAI</strong> (gas — covers thousands of <code>postJob</code> txs) and <strong>5 xBZZ</strong> (job-escrow budget — roughly 5 000 small chats at default prices) to <span class="mono">${escape(address)}</span> on Gnosis. xBZZ is spent per-job (not locked); leftover can be moved out using the Send form below.</p>`
    : ''
  const resultBanner = renderResultBanner(query)
  return `
<section>
  <h2>Wallet</h2>
  ${resultBanner}
  ${fundingBanner}
  <dl class="kv">
    <dt>Address</dt><dd class="mono"><a href="https://gnosisscan.io/address/${escape(address)}" target="_blank" rel="noopener">${escape(address)}</a></dd>
    <dt>xDAI (gas)</dt><dd>${escape(formatXdai(gas as bigint | undefined ?? null))}</dd>
    <dt>xBZZ</dt><dd>${escape(formatXBZZ(xbzz as bigint | undefined ?? null))}</dd>
  </dl>
  <p class="muted">Private key is stored at <span class="mono">/data/wallet.key</span> (bind-mounted from the host). To replace it, delete that file and restart — the onboarding UI will reappear.</p>
</section>
${sendFundsSection()}
${transactionsSection(txs)}`
}

function renderResultBanner(query: Record<string, string>): string {
  if (query.error) return `<p class="notice err"><strong>Error:</strong> ${escape(query.error)}</p>`
  if (query.sent) return `<p class="notice"><strong>Send submitted.</strong> tx <a class="mono" href="https://gnosisscan.io/tx/${escape(query.sent)}" target="_blank" rel="noopener">${escape(shortHex(query.sent))}</a></p>`
  return ''
}

function sendFundsSection(): string {
  return `
<section>
  <h2>Send funds</h2>
  <form method="post" action="/wallet/send" onsubmit="return confirm('Send funds from this wallet?')">
    <div class="kv" style="grid-template-columns:max-content 1fr;gap:8px 12px;margin-bottom:8px;align-items:center">
      <label>Token</label>
      <select name="token" style="width:auto;padding:8px;background:var(--bg-deeper);border:1px solid var(--line-strong);color:var(--ink);font:13px/1.5 var(--font-mono)">
        <option value="xdai">xDAI</option>
        <option value="xbzz">xBZZ</option>
      </select>
      <label>To</label>
      <input type="text" name="to" placeholder="0x…" required pattern="0x[0-9a-fA-F]{40}">
      <label>Amount</label>
      <input type="text" name="amount" placeholder="1.5" required>
    </div>
    <button type="submit">Send</button>
  </form>
  <p class="muted" style="margin-top:8px">Amount is in token units (e.g. "1.5" = 1.5 xDAI or 1.5 xBZZ). Submits a tx signed by this wallet.</p>
</section>`
}

function transactionsSection(txs: import('../../lib/jobs-db').TxRow[]): string {
  if (txs.length === 0) {
    return `<section><h2>Transactions</h2><p class="muted">No on-chain transactions recorded yet.</p></section>`
  }
  const rows = txs.map(t => `<tr>
    <td>${escape(formatTs(t.submittedAt))}</td>
    <td>${escape(t.kind)}</td>
    <td class="mono"><a href="https://gnosisscan.io/tx/${escape(t.hash)}" target="_blank" rel="noopener">${escape(shortHex(t.hash))}</a></td>
    <td class="mono"><a href="https://gnosisscan.io/address/${escape(t.toAddress)}" target="_blank" rel="noopener">${escape(shortHex(t.toAddress))}</a></td>
    <td class="muted">${escape(t.note ?? '')}</td>
  </tr>`).join('')
  return `
<section>
  <h2>Transactions <span class="muted" style="font-weight:normal">(last ${txs.length})</span></h2>
  <table>
    <thead><tr><th>Time (UTC)</th><th>Kind</th><th>Tx</th><th>To</th><th>Note</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`
}
