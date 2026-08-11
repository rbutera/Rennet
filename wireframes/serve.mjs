// Minimal static server for the wireframe gallery. Serves gallery.html at "/".
// Bound to 127.0.0.1:8791 to sit behind `tailscale serve` on :9443.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, normalize } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8791);
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.mjs': 'text/javascript' };

createServer(async (req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/' || rel === '') rel = '/gallery.html';
  const file = resolve(__dir, '.' + normalize(rel));
  if (!file.startsWith(__dir)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const buf = await readFile(file);
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream' }).end(buf);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`wireframe gallery on http://127.0.0.1:${PORT}/`));
