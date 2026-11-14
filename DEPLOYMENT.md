# Deployment

GitFi is deployed as three pieces:

| Piece | Host | What it does |
|---|---|---|
| Frontend + API proxy | Cloudflare Worker with static assets | Serves the React app and `/docs`, proxies `/api`, `/ws`, `/cdn` to Render |
| Backend API | Render web service | Express API, README proof, NEAR chain bridge, indexing |
| Database | Turso | Remote libSQL database used by the API |

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
NEAR_CONTRACT_ID=gitfi-395012.testnet
NEAR_MARKET_CONTRACT_ID=market.gitfi-395012.testnet
NEAR_ORACLE_ACCOUNT_ID=gitfi-395012.testnet
NEAR_ORACLE_PRIVATE_KEY=ed25519:...
TEAM_ADDRESS=gitfi-395012.testnet
LAUNCH_FEE_YOCTO=1000000000000000000000000
NEAR_CHAIN_ENABLED=true
NEAR_RPC_URL=https://rpc.testnet.fastnear.com
NEAR_EXPLORER_URL=https://explorer.testnet.near.org
NEAR_AUTH_RECIPIENT=gitfi.fun
```

The operator key is required for repo deed mints, market creation and on-chain owner updates. Treat it as a production secret and rotate it before mainnet.

Render URL: `https://gitfi-api.onrender.com`

## 3. Cloudflare frontend

`wrangler.jsonc` deploys the built `dist/client` directory as static assets. A small Worker proxies API, WebSocket and uploaded logo requests to Render so the browser sees one origin and the session cookie stays first-party.

```bash
npm run build
npx wrangler deploy
```

Set `API_ORIGIN` in `wrangler.jsonc` to the Render URL.

The Worker serves:

- `/` and all React routes from `dist/client`
- `/docs/` and `/llms.txt`
- `/api/*`, `/ws`, `/cdn/*`, `/uploads/*` proxied to Render

### Custom domain

The intended domains are:

- `gitfi.fun` - frontend
- `docs.gitfi.fun` - documentation (also available at `/docs/` and GitHub Pages)
- `api.gitfi.fun` - optional direct API hostname for Render

To put the Worker on `gitfi.fun`, the domain's nameservers must be managed by Cloudflare (or a DNS CNAME must target the Worker). Then add a Worker custom domain/route:

```bash
npx wrangler deployments list
# Add gitfi.fun in Cloudflare Dashboard -> Workers -> gitfi-fun -> Settings -> Domains
```

If the domain remains on another DNS provider, create the required CNAME/route there. DNS ownership is the only step that cannot be completed from this repository.

## 4. Docs

Docs are static and independent of the API:

- App: `/docs/`
- Worker: `https://<worker-domain>/docs/`
- GitHub Pages: `https://0xnurrabby.github.io/gitfi/`
- Target: `https://docs.gitfi.fun`

The Worker can serve docs at the root when the host starts with `docs.` if the same Render/Express backend is used behind it.

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
