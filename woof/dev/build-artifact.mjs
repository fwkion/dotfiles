// Builds the claude.ai artifact test bench from the real app.
//
//   node dev/build-artifact.mjs           writes dev/artifact/index.html
//   node dev/build-artifact.mjs --serve   ...and serves it on :8090 to check locally
//
// The artifact is web/index.html's body plus the test console
// (dev/artifact/*). The app, vendor and API files are published alongside it
// unchanged. FILES below is the published-path -> source map to publish with.

import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)); // woof/
const r = (p) => join(root, p);

export const FILES = {
  'styles.css': 'web/styles.css',
  'config.js': 'web/config.js',
  'fingerprint.js': 'web/fingerprint.js',
  'app.js': 'web/app.js',
  'vendor/leaflet/leaflet.js': 'web/vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css': 'web/vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png': 'web/vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png': 'web/vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png': 'web/vendor/leaflet/images/marker-shadow.png',
  'vendor/leaflet/images/layers.png': 'web/vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png': 'web/vendor/leaflet/images/layers-2x.png',
  'harness-pre.js': 'dev/artifact/harness-pre.js',
  'harness.mjs': 'dev/artifact/harness.mjs',
  'harness.css': 'dev/artifact/harness.css',
  'api/handler.mjs': 'api/handler.mjs',
  'api/lib/context.mjs': 'api/lib/context.mjs',
  'api/lib/notify.mjs': 'api/lib/notify.mjs',
  'api/lib/store.mjs': 'api/lib/store.mjs',
  'api/lib/validate.mjs': 'api/lib/validate.mjs',
  'api/lib/w3w.mjs': 'api/lib/w3w.mjs',
};

export async function build() {
  const html = await readFile(r('web/index.html'), 'utf8');
  const body = html.match(/<body>([\s\S]*)<\/body>/)[1];
  const consoleHtml = await readFile(r('dev/artifact/console.html'), 'utf8');

  const page = [
    '<title>Woof Tag Tester</title>',
    '<meta name="claude:viewport-fit-sides" content="cover">',
    '<meta name="robots" content="noindex, nofollow">',
    '<link rel="stylesheet" href="vendor/leaflet/leaflet.css">',
    '<link rel="stylesheet" href="styles.css">',
    '<link rel="stylesheet" href="harness.css">',
    body
      .replace('<script src="config.js"></script>', '<script src="harness-pre.js"></script>\n  <script src="config.js"></script>')
      .replace(/(\s*<script src="config.js">)/, `\n${consoleHtml}$1`)
      .trim(),
    '<script type="module" src="harness.mjs"></script>',
    '',
  ].join('\n');

  const out = r('dev/artifact/index.html');
  await writeFile(out, page);
  return out;
}

const out = await build();
console.log(`wrote ${out}`);

if (process.argv.includes('--serve')) {
  const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.html': 'text/html' };
  createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname.replace(/^\//, '');
    try {
      if (path === '' || path === 'index.html') {
        const page = await readFile(out, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>${page}</body></html>`);
        return;
      }
      if (!FILES[path]) throw new Error('not found');
      res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
      res.end(await readFile(r(FILES[path])));
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  }).listen(8090, () => console.log('serving on http://localhost:8090'));
}
