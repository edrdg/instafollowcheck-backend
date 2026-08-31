# InstaFollowCheck — Backend

API backend (Node/Express) for InstaFollowCheck:

- Puppeteer analysis of Instagram followers/following
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
- `WS   /ws`
