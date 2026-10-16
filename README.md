# Rain Drop — Duora's own file host for Rainy

Any file type (audio, video, images, zips, docs). Keyed, disk-capped with LRU prune. Replaces catbox/gofile/file.io for the bot.

## Endpoints

- `POST /upload` — raw bytes, headers `x-filename` + `Content-Type` → `{ url: "/f/<id>" }`
- `GET /f/<id>` — serves file inline with stored content-type (Discord-embed friendly)
- `DELETE /f/<id>?key=` — owner cleanup
- `GET /health` → `{ ok, files, diskMB }`

Auth: header `x-drop-key: <DROP_SECRET>` (or `?key=`). Open when unset.

Env: `PORT`, `DROP_SECRET`, `MAX_FILE_MB` (default 100), `MAX_DISK_MB` (default 1024), `FILE_TTL_HOURS` (default 0 = keep until disk cap prunes oldest).

## Deploy (Render free web service)

1. New → Web Service → this repo, start `node server.js`, health `/health`.
2. `DROP_SECRET` generates from `render.yaml` — copy it.
3. Free tier sleeps when idle (~30s wake on first upload).

## Bot wiring (Rainy)

Env on the bot service:

- `FILE_API_URL` = `https://rain-drop.onrender.com`
- `FILE_API_KEY` = same value as `DROP_SECRET`

Rain Drop runs first in `uploadToWeb`; catbox/gofile/file.io stay as fallback.
