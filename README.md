# Token4Token (T4T)

**Decentralized AI inference marketplace.** Anyone with a GPU runs a provider and earns **xBZZ** per token served. Any OpenAI-compatible app points at a gateway and pays per token — no API keys, no signups, no Stripe.

![T4T gateway + provider demo](docs/media/t4t-demo.gif)

Live at [t4t.eth](https://t4t.eth.limo). Container image: [`ghcr.io/ffaerber/t4t`](https://github.com/ffaerber/t4t/pkgs/container/t4t). Coordination via Swarm + PSS; payment, escrow, registry, and slashing on Gnosis Chain.

## Earn xBZZ with your GPU

You run a **provider** container next to a local Ollama or vLLM. The container:

1. **Registers your offerings on-chain** — every model your local backend exposes gets advertised on the provider registry with your prices (xBZZ per 1M input/output AI tokens).
2. **Listens for jobs over PSS** — clients send encrypted job descriptors directly to your node; no central dispatcher.
3. **Streams encrypted requests + responses through Swarm** — your IP isn't exposed to clients; the content is content-addressed and erasure-coded.
4. **Claims payment on-chain** — at the end of every job, your container calls `JobEscrow.claimJob`. xBZZ moves from the client's escrow row to your wallet, refunding any difference between `maxPayment` and the actual `inputTokens·inputPrice + outputTokens·outputPrice`.

The minimum is **100 xBZZ staked** + a little xDAI for gas + a Bee node + a GPU your backend can drive. You set your own per-model prices in the admin UI at `http://localhost:3000`. Nothing to apply for, nothing to renew — your stake is what lets you accept jobs, and slashing is what backstops your SLA.

Roughly: a 4090 serving `llama3:8b` at the median price on `t4t.eth` earns proportional to tokens served, paid in xBZZ. Profit depends on your power cost, hardware amortisation, and how many concurrent jobs your VRAM supports (`T4T_MAX_CONCURRENT_JOBS`).

→ **[Full provider guide](docs/getting-started-provider.md)** — config, slashing rules, withdrawal flow.

### Why "xBZZ" and not ETH

xBZZ is the [Ethereum Swarm](https://www.ethswarm.org) bridge-token on Gnosis Chain — the same token that pays for the storage every job's payload sits on. Using it for inference means one budget covers both compute and storage; gas costs stay in cents (Gnosis), and the broader Swarm economy gets a second utility surface besides postage stamps. Buy on the [Swarm get-bzz page](https://www.ethswarm.org/get-bzz) or bridge from Ethereum mainnet.

## Use it from any OpenAI app

You run a **gateway** container locally. Point Open WebUI, LibreChat, Continue.dev, or any OpenAI-compatible app at `http://localhost:8080/v1`. The gateway picks a provider for each request (top-reputation, cheapest by default), escrows the maximum payment in xBZZ, ships the encrypted request through Swarm, returns the streamed response to your app, and settles on-chain automatically.

```bash
curl http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"llama3:8b","messages":[{"role":"user","content":"hi"}]}'
```

No API key for the gateway. Your wallet is the API key.

→ **[Full gateway guide](docs/getting-started-gateway.md)** — config, payment flow, app integration.

## How it works (60 seconds)

```
┌──────────────┐  POST /v1/chat   ┌──────────────┐
│  Your app    │ ───────────────► │  T4T gateway │
│ (Open WebUI, │                  │  (you run)   │
│  curl, IDE)  │ ◄─────────────── │              │
└──────────────┘   streamed reply └──────┬───────┘
                                         │
                          ┌──────────────┼─────────────────┐
                          ▼              ▼                 ▼
                       ┌──────┐     ┌────────┐        ┌──────────┐
                       │SWARM │     │ GNOSIS │        │   PSS    │
                       │ (req/│     │(escrow,│        │ (job ack,│
                       │ resp)│     │ claim) │        │ deliver) │
                       └──────┘     └────────┘        └──────────┘
                          ▲              ▲                 ▲
                          │              │                 │
                          └──────────┐   │   ┌─────────────┘
                                     ▼   ▼   ▼
                                ┌──────────────┐
                                │ T4T provider │     ┌──────────────┐
                                │  (you / a    │ ──► │ Ollama / vLLM│
                                │   peer)      │ ◄── │ (local GPU)  │
                                └──────────────┘     └──────────────┘
```

Step by step:

1. **Gateway picks a provider** by reading the on-chain registry and filtering on model + price + reputation.
2. **Gateway uploads the encrypted prompt to Swarm** (ECIES to the provider's pubkey), getting back a 32-byte content hash.
3. **Gateway calls `postJob`** on `JobEscrow`, locking `maxPayment` xBZZ. The job is identified by the Swarm hash; the on-chain state stores only the hash + payment terms.
4. **Gateway notifies the provider over PSS**, signed and pinned to that job ID.
5. **Provider fetches from Swarm, decrypts, runs inference** against its local Ollama/vLLM, uploads the response back to Swarm, then PSS-delivers the response hash to the gateway.
6. **Gateway fetches the response from Swarm** and streams it back to your app.
7. **Provider calls `claimJob`** with the actual token counts. Escrow pays the provider, refunds the excess to the gateway. Done.

If the provider misses the ACK deadline or the delivery deadline, the gateway cancels the job and the provider's stake is **slashed and burned** (not paid to the gateway — that would invert the incentive and reward grief). Full protocol: [docs/spec.md](docs/spec.md). Sequence detail: [docs/flow.md](docs/flow.md).

## Repository layout

```
t4t/
├── contracts/           # Foundry: ProviderRegistry, JobEscrow
│   ├── src/
│   ├── test/
│   └── script/Deploy.s.sol
├── container/           # TS: one image, two modes
│   ├── src/
│   │   ├── lib/         # envelope, swarm, chain, ollama, crypto, config
│   │   ├── modes/gateway/
│   │   └── modes/provider/
│   ├── test/
│   └── Dockerfile
├── docs/
│   ├── spec.md
│   ├── flow.md
│   ├── architecture.md
│   ├── getting-started-gateway.md
│   └── getting-started-provider.md
├── website/             # t4t.eth landing page + live model directory
├── docker-compose.provider-example.yml   # provider + ollama (+ optional bee)
├── docker-compose.gateway-example.yml    # gateway + open-webui (+ optional bee)
└── Makefile
```

## Quick start (dev)

Prereqs: Foundry, Node ≥ 20, Docker (optional), a Bee node, an Ollama node, and a Gnosis Chain RPC.

```bash
make install            # forge install + npm install
make test               # forge test + vitest (hermetic)
make build              # forge build + tsc
make docker             # build container image  (or `docker pull ghcr.io/ffaerber/t4t`)
```

### Fork tests

Run the contract suite end-to-end against a Gnosis Chain fork and the real
xBZZ ERC-20 — mirrors SwarmChat's fork-test pattern:

```bash
FORK_GNOSIS_RPC_URL=https://rpc.gnosischain.com make test-contracts-fork
```

Wallets are seeded via `vm.deal`; no whale impersonation needed. Excluded
from `make test` so the default loop stays hermetic.

### Local end-to-end (M1)

1. Run Anvil forked from Gnosis: `make anvil`
2. Deploy contracts: `make deploy-local` (writes addresses to console)
3. Copy the relevant example (`docker-compose.provider-example.yml` or `docker-compose.gateway-example.yml`) → `docker-compose.yml`. Defaults work against the live Gnosis-mainnet deployment; the admin UI handles wallet onboarding on first boot.
4. `docker compose up bee ollama`
5. Pull a model: `docker exec -it $(docker compose ps -q ollama) ollama pull llama3:8b`
6. `docker compose up t4t-provider t4t-gateway`
7. Point any OpenAI-compatible app at `http://localhost:8080/v1`

See [docs/getting-started-gateway.md](docs/getting-started-gateway.md) and [docs/getting-started-provider.md](docs/getting-started-provider.md) for details.

## Status

Scaffold for M1 ("Loop closed"). Cipher is currently a passthrough — see `container/src/lib/crypto.ts`. ECIES wire-up and event-indexed claimJob resolution land before M2. Roadmap in [`docs/spec.md` §12](docs/spec.md).

Inspired by [SwarmChat](https://github.com/ffaerber/SwarmChat) — same envelope discipline, same Gnosis + Swarm substrate.
