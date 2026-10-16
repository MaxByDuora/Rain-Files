// rain-drop/server.js — Duora's own file host ("Rain Drop").
// ANY file type: audio, video, images, zips, docs. Keyed, disk-capped w/ LRU prune.
//   POST /upload  (raw bytes, headers x-filename + content-type) -> { url: "/f/<id>" }
//   GET  /f/<id>  (serves with stored content-type, inline)
//   DELETE /f/<id>?key= (owner cleanup)
//   GET  /health  -> { ok, files, disk }
// Auth: header x-drop-key: <DROP_SECRET> (or ?key=). Open when unset.
// Env: PORT, DROP_SECRET, MAX_FILE_MB (default 100), MAX_DISK_MB (default 1024),
//      FILE_TTL_HOURS (default 0 = keep until disk cap prunes oldest).
// Designed for Render free web service. Zero dependencies.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3002);
const SECRET = String(process.env.DROP_SECRET || '');
const MAX_FILE = (Number(process.env.MAX_FILE_MB) || 100) * 1024 * 1024;
const MAX_DISK = (Number(process.env.MAX_DISK_MB) || 1024) * 1024 * 1024;
const TTL = (Number(process.env.FILE_TTL_HOURS) || 0) * 3600 * 1000;
const VERSION = '1.0.0';

const DIR = path.join(__dirname, 'data');
try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
const IDX_FILE = path.join(DIR, 'index.json');
let IDX = {};
try { if (fs.existsSync(IDX_FILE)) IDX = JSON.parse(fs.readFileSync(IDX_FILE, 'utf8')) || {}; } catch {}
function idxSave() { try { fs.writeFileSync(IDX_FILE, JSON.stringify(IDX)); } catch {} }
function diskUsed() { let n = 0; for (const k of Object.keys(IDX)) n += Number(IDX[k].size) || 0; return n; }
function prune() {
  try {
    while (diskUsed() > MAX_DISK) {
      const keys = Object.keys(IDX).sort((a, b) => (IDX[a].at || 0) - (IDX[b].at || 0));
      if (!keys.length) break;
      drop(keys[0]);
    }
  } catch {}
}
function drop(id) {
  try {
    const e = IDX[id];
    if (e && e.file) { try { fs.unlinkSync(path.join(DIR, e.file)); } catch {} }
    delete IDX[id];
    idxSave();
  } catch {}
}
setInterval(() => { // ttl sweep
  if (!TTL) return;
  try {
    const now = Date.now();
    for (const k of Object.keys(IDX)) if (now - (IDX[k].at || 0) > TTL) drop(k);
  } catch {}
}, 3600000).unref?.();

const EXT2MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain', json: 'application/json', csv: 'text/csv' };
function send(res, code, obj, type) {
  const body = Buffer.isBuffer(obj) ? obj : Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': type || 'application/json', 'Access-Control-Allow-Origin': '*', 'Content-Length': body.length });
  res.end(body);
}
function authed(req, u) {
  if (!SECRET) return true;
  return req.headers['x-drop-key'] === SECRET || u.searchParams.get('key') === SECRET;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); return res.end(); }
  if (u.pathname === '/health') {
    const files = Object.keys(IDX).length;
    return send(res, 200, { ok: true, version: VERSION, files, diskMB: Math.round(diskUsed() / 1048576) });
  }
  if (u.pathname === '/upload' && req.method === 'POST') {
    if (!authed(req, u)) return send(res, 401, { error: 'bad key' });
    const chunks = [];
    let size = 0, dead = false;
    req.on('data', (c) => {
      if (dead) return;
      size += c.length;
      if (size > MAX_FILE + 1024 * 1024) { dead = true; try { req.destroy(); } catch {} return send(res, 413, { error: 'file too big (max ' + Math.round(MAX_FILE / 1048576) + 'MB)' }); }
      chunks.push(c);
    });
    req.on('end', () => {
      if (dead) return;
      try {
        const buf = Buffer.concat(chunks);
        if (!buf.length) return send(res, 400, { error: 'empty body' });
        const rawName = String(req.headers['x-filename'] || u.searchParams.get('name') || 'file.bin').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
        const ext = (rawName.split('.').pop() || '').toLowerCase();
        let type = String(req.headers['content-type'] || '').split(';')[0].trim() || EXT2MIME[ext] || 'application/octet-stream';
        const id = crypto.randomBytes(6).toString('hex') + (ext && /^[a-z0-9]{1,5}$/.test(ext) ? '.' + ext : '');
        fs.writeFileSync(path.join(DIR, id), buf);
        IDX[id] = { name: rawName, type, size: buf.length, at: Date.now(), file: id };
        idxSave();
        prune();
        return send(res, 200, { url: '/f/' + id, id, size: buf.length, type });
      } catch (e) { return send(res, 500, { error: String((e && e.message) || e).slice(0, 200) }); }
    });
    req.on('error', () => { try { send(res, 500, { error: 'upload io error' }); } catch {} });
    return;
  }
  const fm = u.pathname.match(/^\/f\/([A-Za-z0-9.]{4,40})$/);
  if (fm) {
    const id = fm[1];
    const e = IDX[id];
    const fp = path.join(DIR, path.basename(id));
    if (!e || !fs.existsSync(fp)) return send(res, 404, { error: 'not found' });
    if (req.method === 'DELETE') {
      if (!authed(req, u)) return send(res, 401, { error: 'bad key' });
      drop(id);
      return send(res, 200, { ok: true });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' });
    try {
      const st = fs.statSync(fp);
      res.writeHead(200, {
        'Content-Type': e.type || 'application/octet-stream',
        'Content-Length': st.size,
        'Content-Disposition': 'inline; filename="' + String(e.name || id).replace(/"/g, '') + '"',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=31536000',
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(fp).pipe(res);
    } catch { return send(res, 500, { error: 'read failed' }); }
  }
  return send(res, 404, { error: 'use POST /upload, GET /f/<id>, GET /health' });
});

server.listen(PORT, () => console.log('[Rain Drop] up on :' + PORT + ' (auth ' + (SECRET ? 'on' : 'OFF/dev') + ')'));
