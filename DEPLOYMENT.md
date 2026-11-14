# Deployment

GitFi is deployed as three pieces:

| Piece | Host | Live URL |
|---|---|---|
| Frontend + API proxy | Cloudflare Worker with static assets | `https://gitfi.fun` |
| Backend API | Render web service | `https://gitfi-api.onrender.com` |
| Database | Turso | `libsql://gitfi-gitfi.aws-ap-south-1.turso.io` |

The primary domain is `gitfi.fun`. `docs.gitfi.fun` serves the handbook from the same Worker. `www.gitfi.fun` redirects to the primary domain.

## 1. Turso

Create a database and copy the `libsql://` URL and auth token.

```ini
TURSO_DATABASE_URL=libsql://your-database.turso.io
TURSO_AUTH_TOKEN=...
```

The schema is created on first boot by `src/server/db.ts`. The app uses libSQL's synchronous API for both local SQLite and remote Turso, so the existing server code does not need an async rewrite.

To copy existing data into Turso:

```bash
# Stop the local server first.
TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npx tsx data/migrate-turso.ts
```

Only non-sandbox users and repository metadata need to be copied. Token and market data can start empty because the active on-chain market set is clean.

## 2. Render backend

Create a **Web Service** from the GitHub repository.

- Runtime: Node
- Plan: Free (or paid for always-on)
- Region: Singapore
- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Health check: `/api/health`

Environment:

```ini
NODE_ENV=production
NODE_VERSION=24
APP_URL=https://gitfi.fun

TURSO_DATABASE_URL=...
TURSO_AUTH_TOKEN=...
SESSION_SECRET=...
ADMIN_TOKEN=...
SEED_DEMO=false
DEMO_MODE=false

NEAR_NETWORK=testnet
NEAR_CONTRACT_ID=registry.gitfi-395012.testnet
NEAR_MARKET_CONTRACT_ID=market.gitfi-395012.testnet
NEAR_ORACLE_ACCOUNT_ID=gitfi-395012.testnet
NEAR_ORACLE_PRIVATE_KEY=ed25519:...
TEAM_ADDRESS=gitfi-395012.testnet
LAUNCH_FEE_YOCTO=1000000000000000000000000
NEAR_CHAIN_ENABLED=true
NEAR_RPC_URL=https://rpc.testnet.fastnear.com
NEAR_RPC_PROXY_URL=https://gitfi.fun/rpc
NEAR_RPC_PROXY_TOKEN=...
NEAR_EXPLORER_URL=https://explorer.testnet.near.org
NEAR_AUTH_RECIPIENT=gitfi.fun
```

The operator key is required for repo deed mints, market creation and on-chain owner updates. Treat it as a production secret and rotate it before mainnet.

`NEAR_RPC_PROXY_URL` points at the Worker RPC relay. It keeps backend reads and oracle transactions off Render's shared egress IP, which public NEAR RPC endpoints rate-limit. Set `NEAR_RPC_PROXY_TOKEN` to the same value as the Worker's `RPC_PROXY_TOKEN` secret. Direct `NEAR_RPC_URL` stays as a fallback.

Render URL: `https://gitfi-api.onrender.com`

## 3. Cloudflare frontend

`wrangler.jsonc` deploys the built `dist/client` directory as static assets. A small Worker proxies API, WebSocket and uploaded logo requests to Render so the browser sees one origin and the session cookie stays first-party.

```bash
npm run build
npx wrangler deploy
```

Set `API_ORIGIN` in `wrangler.jsonc` to the Render URL.

The Worker also exposes a private JSON-RPC relay at `/rpc` for the backend. Create its shared secret once:

```bash
npx wrangler secret put RPC_PROXY_TOKEN
```

The secret must match `NEAR_RPC_PROXY_TOKEN` on Render.

The Worker serves:

- `/` and all React routes from `dist/client`
- `/docs/` and `/llms.txt`
- `/api/*`, `/ws`, `/cdn/*`, `/uploads/*` proxied to Render

### Domains

- `gitfi.fun` - primary app
- `docs.gitfi.fun` - docs
- `www.gitfi.fun` - redirects to `gitfi.fun`

`gitfi.fun` and `docs.gitfi.fun` are active Cloudflare zones/domains. The Worker serves the app at the apex, maps the docs host to the docs bundle, and redirects `www` to the apex. API and uploads are proxied under the same origin.

The static docs also work on GitHub Pages and at `/docs/`.

## 4. Docs

Docs are static and independent of the API:

- App: `/docs/`
- Production: `https://docs.gitfi.fun`
- GitHub Pages: `https://0xnurrabby.github.io/gitfi/`

## Health checks

```bash
curl https://gitfi-api.onrender.com/api/health
curl https://gitfi-api.onrender.com/api/home
```

Expected: HTTP 200 and a JSON response with an empty or live market set.

## Security notes

- Never commit `.env`, Turso tokens, Render keys or the NEAR operator private key.
- Set `SESSION_SECRET` and `ADMIN_TOKEN` explicitly on Render. Do not rely on generated files on an ephemeral disk.
- Render free instances have ephemeral disks. Uploaded logo files can disappear on redeploy. Tokens and market data are safe in Turso and NEAR.
- The app is testnet-only and not audited. Complete the mainnet checklist before accepting real funds.
