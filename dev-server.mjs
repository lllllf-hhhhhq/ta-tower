import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/dev.html';
  const f = path.join(root, p);
  if (!f.startsWith(root)) { res.writeHead(403).end(); return; }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404).end('404'); return; }
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
    res.end(d);
  });
}).listen(8123, '127.0.0.1', () => console.log('serving on http://127.0.0.1:8123'));
