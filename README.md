# GDL — Discovery Bridges (live)

Live Claude reasoning through a thin Node proxy. The API key lives server-side and
is never exposed to the client. The frontend calls the server first and falls back
automatically to a 22-book tagged catalog if the server is unreachable, with a
visible mode badge (**Live — reasoning through Claude** vs **Offline — using tagged catalog**).

## Architecture

- `server.js` — Express, two routes:
  - `POST /api/reflect` — reflects the person's taste back (one call, capped at 400 tokens)
  - `POST /api/bridges` — builds the four Discovery Bridges (one call, capped at 900 tokens)
  - `GET /api/health` — reports whether a key is configured, the model, and today's call count
- `public/index.html` — GDL identity (black/red, Archivo/Inter/IBM Plex Mono), three-step flow, offline fallback baked in.

## Cost fence

- Per-request `max_tokens` ceilings (reflect 400, bridges 900).
- Per-IP rate limit: 8 calls/minute.
- Global daily call cap: `GDL_DAILY_CAP` (default 300). Past the cap, the server returns 429 and the frontend drops to the offline catalog.

## Run locally

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
# open http://localhost:3000
```

Without a key it still serves — in offline mode.

## Deploy to Render

1. Push this folder to a GitHub repo.
2. Render → New → Web Service → point at the repo (`render.yaml` is picked up automatically).
3. Set the `ANTHROPIC_API_KEY` env var in the Render dashboard (marked `sync: false` so it is never committed).
4. Confirm `GDL_MODEL` against the current list at docs.claude.com before going live — model names change. Default is `claude-sonnet-5`.
5. Deploy. Health check: `https://<your-app>.onrender.com/api/health` should report `keyConfigured: true`.

## Put it on johnmills.design

Two options:
- **Subdomain / link:** point `bridges.johnmills.design` (or a page button) at the Render URL.
- **Embed:** `<iframe src="https://<your-app>.onrender.com" style="width:100%;height:900px;border:0"></iframe>` on a johnmills.design page.

The offline toggle is already built in, so the same deploy can sit alongside the
static offline-pool version or replace it as the "live mode" surface.
