// Tiny static server that mimics Vercel for a Vite `dist/`: applies the headers from vercel.json,
// serves correct MIME types, and answers 404 (not index.html) for unknown paths.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.json': 'application/json' };

// vercel.json "source" patterns here only use `(.*)`; turn them into regexes
const toRegExp = (source) => new RegExp(`^${source.replace(/\(\.\*\)/g, '.*')}$`);

export async function serveDir(dir, vercelConfig) {
  const rules = (vercelConfig.headers ?? []).map((r) => ({ re: toRegExp(r.source), headers: r.headers }));
  const server = http.createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = normalize(join(dir, path));
    if (!file.startsWith(dir)) return res.writeHead(403).end();
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      const headers = { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Content-Length': body.length };
      for (const r of rules) if (r.re.test(path)) for (const h of r.headers) headers[h.key] = h.value;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://localhost:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) };
}
