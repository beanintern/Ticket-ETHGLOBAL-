// Production static server for the built app (dist/), with no dependencies.
// Used by `npm start` (e.g. on Railway). Live market data doesn't go through this server:
// the browser connects to Derive's WebSocket directly.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./dist/', import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

async function fileFor(pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  const full = join(ROOT, rel);
  if (!full.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep) && full !== ROOT.replace(/[/\\]$/, '')) return null; // no path traversal
  try {
    const s = await stat(full);
    if (s.isFile()) return { full, size: s.size };
    if (s.isDirectory()) {
      const idx = join(full, 'index.html');
      const si = await stat(idx);
      return { full: idx, size: si.size };
    }
  } catch {
    /* not found */
  }
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  // Unknown paths get the app (single-page app fallback).
  const file = (await fileFor(url.pathname)) ?? (await fileFor('/index.html'));
  if (!file) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end('Build output missing: run `npm run build` first.');
    return;
  }
  const hashed = file.full.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    'content-type': TYPES[extname(file.full)] ?? 'application/octet-stream',
    'content-length': file.size,
    // Vite fingerprints files in assets/, so they can be cached forever; index.html must not be.
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file.full).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => console.log(`Ticket serving dist/ on port ${PORT}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
