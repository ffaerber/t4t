SHELL := /bin/bash
-include .env
export

# === Config ===
BEE_API_URL    ?= http://localhost:1633
RPC_URL        ?= https://rpc.gnosischain.com
CHIADO_RPC_URL ?= https://rpc.chiadochain.net
LOCAL_RPC_URL  ?= http://localhost:8545
ENS_NAME       ?= t4t.eth

.PHONY: help
help: ## Show this help
	@# -h matters: `-include .env` puts two files in MAKEFILE_LIST, so grep
	@# prefixes every line with its filename and awk's $$1 became "Makefile"
	@# for all of them. The list has never shown a target name without it.
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-22s\033[0m %s\n", $$1, $$2}'

# ============================================================
#  Setup
# ============================================================

.PHONY: install
install: install-contracts install-container ## Install all dependencies

.PHONY: install-contracts
install-contracts: ## Install forge-std into contracts/lib
	cd contracts && forge install foundry-rs/forge-std --no-git --no-commit

.PHONY: install-container
install-container: ## Install container npm dependencies
	cd container && npm install

# ============================================================
#  Development
# ============================================================

.PHONY: anvil
anvil: ## Start local Anvil fork of Gnosis Chain
	anvil --fork-url $(RPC_URL) --chain-id 100 --port 8545

.PHONY: dev-gateway
dev-gateway: ## Run gateway mode with tsx watch
	cd container && T4T_MODE=gateway npm run dev

.PHONY: dev-provider
dev-provider: ## Run provider mode with tsx watch
	cd container && T4T_MODE=provider npm run dev

# ============================================================
#  Testing
# ============================================================

.PHONY: test
test: test-contracts test-container ## Run all tests

.PHONY: test-contracts
test-contracts: ## Forge unit + fuzz + invariant tests (hermetic, no fork)
	cd contracts && forge test -vvv --no-match-contract ForkTest

.PHONY: test-contracts-gas
test-contracts-gas: ## Forge with gas report
	cd contracts && forge test --gas-report --no-match-contract ForkTest

.PHONY: test-contracts-fork
test-contracts-fork: ## Forge end-to-end against a Gnosis Chain fork + real xBZZ
	cd contracts && FORK_GNOSIS_RPC_URL=$${FORK_GNOSIS_RPC_URL:-$(RPC_URL)} \
		forge test --match-contract ForkTest -vvv

.PHONY: test-container
test-container: ## Container vitest suite
	cd container && npm test

# ============================================================
#  Build
# ============================================================

.PHONY: build
build: build-contracts build-container ## Build everything

.PHONY: build-contracts
build-contracts: ## forge build
	cd contracts && forge build

.PHONY: build-container
build-container: ## TypeScript build
	cd container && npm run build

.PHONY: docker
docker: ## Build the t4t container image
	docker build -t t4t:dev container

.PHONY: fmt
fmt: ## Format Solidity
	cd contracts && forge fmt

# ============================================================
#  Deploy
# ============================================================

.PHONY: deploy-chiado
deploy-chiado: build-contracts ## Deploy contracts to Chiado testnet
	@test -n "$$XBZZ_ADDRESS"   || { echo "Set XBZZ_ADDRESS in .env"; exit 1; }
	@test -n "$$TREASURY_OWNER" || { echo "Set TREASURY_OWNER in .env"; exit 1; }
	@test -n "$$PRIVATE_KEY"    || { echo "Set PRIVATE_KEY in .env"; exit 1; }
	cd contracts && forge script script/Deploy.s.sol:DeployScript \
		--rpc-url $(CHIADO_RPC_URL) \
		--private-key $$PRIVATE_KEY \
		--broadcast

XBZZ_MAINNET ?= 0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da

.PHONY: deploy-mainnet
deploy-mainnet: build-contracts ## Deploy contracts to Gnosis Chain mainnet (IRREVERSIBLE)
	@test -n "$$MNEMONIC"            || { echo "Set MNEMONIC in .env";        exit 1; }
	@test -n "$$MNEMONIC_INDEX"      || { echo "Set MNEMONIC_INDEX in .env";  exit 1; }
	@test -n "$$ADDRESS"             || { echo "Set ADDRESS in .env (must match MNEMONIC_INDEX)"; exit 1; }
	@test -n "$$GNOSISSCAN_API_KEY"  || { echo "Set GNOSISSCAN_API_KEY in .env (free at gnosisscan.io)"; exit 1; }
	@test "$$CONFIRM_MAINNET" = "yes-i-mean-it" || { echo "Refusing to deploy without CONFIRM_MAINNET=yes-i-mean-it"; exit 1; }
	@echo "→ Deploying to Gnosis Chain mainnet via $(RPC_URL)"
	@echo "  xBZZ           : $(XBZZ_MAINNET)"
	@echo "  Deployer/Owner : $$ADDRESS (mnemonic index $$MNEMONIC_INDEX)"
	cd contracts && XBZZ_ADDRESS=$(XBZZ_MAINNET) TREASURY_OWNER=$$ADDRESS \
		forge script script/Deploy.s.sol:DeployScript \
			--rpc-url $(RPC_URL) \
			--mnemonics "$$MNEMONIC" \
			--mnemonic-indexes $$MNEMONIC_INDEX \
			--sender $$ADDRESS \
			--chain gnosis \
			--broadcast \
			--verify

.PHONY: deploy-local
deploy-local: build-contracts ## Deploy contracts to local Anvil
	cd contracts && forge script script/Deploy.s.sol:DeployScript \
		--rpc-url $(LOCAL_RPC_URL) \
		--private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
		--broadcast

# ============================================================
#  Website (t4t.eth)
# ============================================================
#
# Three steps, and the last one is the one that counts. Swarm keeps the chunks
# a BATCH pays for, so an upload alone changes nothing anyone can see: the name
# keeps resolving to the previous reference and stays tied to whichever batch
# stamped it. Until the contenthash moves, a deploy is invisible and the site
# is hostage to a batch that may be days from expiring.
#
#   make website-deploy WEBSITE_BATCH_ID=…      # prints ref + contenthash
#   make website-ens CONTENTHASH=0xe40101…      # simulate the resolver write
#   make website-ens-broadcast CONTENTHASH=…    # send it (mainnet, costs gas)

# The postage batch stamping the site. Deliberately NOT defaulted to BATCH_ID:
# that one belongs to the provider, and sharing a batch between the two means a
# job response and a deploy can evict each other's chunks.
WEBSITE_BATCH_ID ?=
# Only needed when BEE_API_URL points at swarm-stamp-monitor instead of a Bee
# node — the node holding these stamps is not on the public internet.
BEE_API_KEY      ?=

.PHONY: website-build
website-build: ## Build the t4t.eth website into website/dist
	cd website && npm install --silent && npm run build

.PHONY: website-deploy
website-deploy: website-build ## Upload website/dist to Swarm; prints ref + ENS contenthash
	@test -n "$(WEBSITE_BATCH_ID)" || { echo "Set WEBSITE_BATCH_ID (a funded postage batch for the site)"; exit 1; }
	cd website && BEE_API_URL=$(BEE_API_URL) BEE_API_KEY=$(BEE_API_KEY) \
		POSTAGE_BATCH_ID=$(WEBSITE_BATCH_ID) node deploy-swarm.mjs

.PHONY: website-ens
website-ens: ## Dry-run the ENS contenthash update (CONTENTHASH=0xe40101…)
	@test -n "$(CONTENTHASH)" || { echo "Set CONTENTHASH=0xe40101… (printed by website-deploy)"; exit 1; }
	@test -n "$$MNEMONIC"     || { echo "Set MNEMONIC in .env";     exit 1; }
	@test -n "$$ETH_RPC_URL"  || { echo "Set ETH_RPC_URL in .env (Ethereum mainnet, not Gnosis)"; exit 1; }
	cd website && node ens-set-contenthash.mjs $(CONTENTHASH)

.PHONY: website-ens-broadcast
website-ens-broadcast: ## Send the ENS contenthash tx for $(ENS_NAME) (MAINNET, costs gas)
	@test -n "$(CONTENTHASH)" || { echo "Set CONTENTHASH=0xe40101… (printed by website-deploy)"; exit 1; }
	@test -n "$$MNEMONIC"     || { echo "Set MNEMONIC in .env";     exit 1; }
	@test -n "$$ETH_RPC_URL"  || { echo "Set ETH_RPC_URL in .env (Ethereum mainnet, not Gnosis)"; exit 1; }
	@echo "→ Setting contenthash on $(ENS_NAME) (Ethereum mainnet)"
	cd website && node ens-set-contenthash.mjs $(CONTENTHASH) --broadcast

.PHONY: clean
clean: ## Remove build artifacts
	cd contracts && forge clean
	rm -rf container/dist container/node_modules
