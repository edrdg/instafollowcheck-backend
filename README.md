# InstaFollowCheck — Backend

API backend (Node/Express) for InstaFollowCheck:

- Puppeteer (`puppeteer-core`) analysis of Instagram followers/following
- Chromium from `@sparticuz/chromium`: build leggera inclusa nelle dipendenze
  npm, ottimizzata per ambienti con poca RAM (piano free Render, 512 MB) —
  niente Chrome di sistema, niente download a runtime, niente Docker
- Embedded-browser screencast + input relay over WebSocket (`/ws`)
- Progress events over SSE (`/api/events`)
- Auth: validates the user's Supabase JWT via `/auth/v1/user`

## Env vars
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `PORT`
- `ALLOWED_ORIGIN` (comma-separated frontend origins)
- Optional `CF_*` timing overrides (CF_PAGE_LOAD_MS, CF_SCROLL_GAP_MS, …)

## Run
```bash
npm install
npm start
```

## Endpoints (all except /api/health require a valid Supabase access token)
- `GET  /api/health`
- `GET  /api/status`
- `GET  /api/events` (SSE)
- `POST /api/open` / `/api/logout` / `/api/analyze` / `/api/close`
- `GET  /api/peek`
- `GET  /api/debug` (diagnostics: resolved Chromium build)
- `WS   /ws`