// Local development server: serves web/ and routes /api/* to the Lambda
// handler, mimicking API Gateway's HTTP API (payload v2) event.
//
//   node dev/server.mjs            -> http://localhost:8080
//   PORT=3000 node dev/server.mjs
//
// Records go to dev/data.json. Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_IDS to
// get real phone notifications while testing; otherwise they're printed here.
// Note: browsers only allow geolocation on https or localhost.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handler } from '../api/handler.mjs';

const root = fileURLToPath(new URL('../web/', import.meta.url));
const port = Number(process.env.PORT || 8080);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const result = await handler({
        version: '2.0',
        rawPath: url.pathname,
        rawQueryString: url.search.slice(1),
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        isBase64Encoded: false,
        requestContext: {
          http: { method: req.method, path: url.pathname, sourceIp: req.socket.remoteAddress?.replace(/^::ffff:/, '') },
        },
      });
      res.writeHead(result.statusCode, result.headers);
      res.end(result.body);
      return;
    }
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (path.endsWith('/')) path += 'index.html';
    const file = join(root, path);
    if (!file.startsWith(root)) throw Object.assign(new Error(), { code: 'ENOENT' });
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain' });
    res.end(err.code === 'ENOENT' ? 'not found' : String(err));
  }
}).listen(port, () => console.log(`woof dev server on http://localhost:${port}`));
