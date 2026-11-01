import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IP_LOOKUP = 'off';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TABLE_NAME;

const { handler } = await import('../api/handler.mjs');
const { setStore, getStore } = await import('../api/lib/store.mjs');
const { what3words, point, sanitize } = await import('../api/lib/validate.mjs');
const { describeDevice, visitMessage, foundMessage, esc } = await import('../api/lib/notify.mjs');
const { clientIp } = await import('../api/lib/context.mjs');

// Silence the console "notifications".
console.log = () => {};

beforeEach(() => {
  process.env.LOCAL_STORE_FILE = join(mkdtempSync(join(tmpdir(), 'woof-')), 'data.json');
  setStore(undefined);
});

const req = (method, path, body, extra = {}) =>
  handler({
    rawPath: path,
    headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', ...extra.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: { http: { method, sourceIp: '203.0.113.7' } },
  });
const json = (r) => JSON.parse(r.body);

test('visit is stored with server context and client fingerprint', async () => {
  const r = await req('POST', '/api/visit', { client: { visitorId: 'abc', screen: { width: 390 } } });
  assert.equal(r.statusCode, 201);
  const { id } = json(r);
  const data = await getStore().all();
  assert.equal(data[id].type, 'visit');
  assert.equal(data[id].server.ip, '203.0.113.7');
  assert.equal(data[id].client.visitorId, 'abc');
  assert.match(data[id].server.headers['user-agent'], /iPhone/);
});

test('location is appended to a visit', async () => {
  const { id } = json(await req('POST', '/api/visit', { client: {} }));
  const r = await req('POST', `/api/visit/${id}/location`, { location: { lat: 51.5, lon: -0.12, accuracy: 12, source: 'device' } });
  assert.equal(r.statusCode, 200);
  await req('POST', `/visit/${id}/location`, { location: { lat: 51.50001, lon: -0.12, accuracy: 4 } });
  const item = (await getStore().all())[id];
  assert.equal(item.locations.length, 2);
  assert.equal(item.locations[0].accuracy, 12);
});

test('location for unknown or malformed visit is rejected', async () => {
  assert.equal((await req('POST', '/api/visit/nope/location', { location: { lat: 1, lon: 1 } })).statusCode, 400);
  const unknown = '11111111-1111-4111-8111-111111111111';
  assert.equal((await req('POST', `/api/visit/${unknown}/location`, { location: { lat: 1, lon: 1 } })).statusCode, 404);
  const { id } = json(await req('POST', '/api/visit', {}));
  assert.equal((await req('POST', `/api/visit/${id}/location`, { location: { lat: 200, lon: 1 } })).statusCode, 400);
});

test('found claim with map pin and what3words', async () => {
  const r = await req('POST', '/api/found', {
    current: { lat: 51.5, lon: -0.1, source: 'device', accuracy: 8 },
    foundSameAsCurrent: false,
    foundW3W: '///Filled.Count.Soap',
    phone: '+44 7700 900123',
    name: '<b>Sam</b>',
  });
  assert.equal(r.statusCode, 201);
  const item = (await getStore().all())[json(r).id];
  assert.equal(item.type, 'found');
  assert.equal(item.foundW3W, 'filled.count.soap');
  assert.equal(item.finder.phone, '+44 7700 900123');
  assert.match(foundMessage(item), /&lt;b&gt;Sam/); // escaped in the notification
});

test('empty found claim is rejected', async () => {
  const r = await req('POST', '/api/found', { foundSameAsCurrent: true, phone: '  ' });
  assert.equal(r.statusCode, 400);
});

test('bad JSON, oversize payloads and unknown routes', async () => {
  const bad = await handler({ rawPath: '/api/visit', body: '{', requestContext: { http: { method: 'POST' } } });
  assert.equal(bad.statusCode, 400);
  const big = await handler({ rawPath: '/api/visit', body: 'x'.repeat(70000), requestContext: { http: { method: 'POST' } } });
  assert.equal(big.statusCode, 413);
  assert.equal((await req('GET', '/api/whatever')).statusCode, 404);
  assert.equal((await req('OPTIONS', '/api/visit')).statusCode, 204);
});

test('what3words parsing', () => {
  assert.equal(what3words('///index.home.raft'), 'index.home.raft');
  assert.equal(what3words('https://what3words.com/index.home.raft'), 'index.home.raft');
  assert.equal(what3words('https://w3w.co/index.home.raft?x=1'), 'index.home.raft');
  assert.equal(what3words('index home raft'), 'index.home.raft');
  assert.equal(what3words('écrire.été.ça'), 'écrire.été.ça');
  assert.equal(what3words('two.words'), undefined);
  assert.equal(what3words('a.b.c.d'), undefined);
  assert.equal(what3words(42), undefined);
});

test('point validation', () => {
  assert.deepEqual(point({ lat: '51.5', lon: -0.1, accuracy: null }), { lat: 51.5, lon: -0.1 });
  assert.equal(point({ lat: 91, lon: 0 }), undefined);
  assert.equal(point({ lat: 1 }), undefined);
});

test('sanitize truncates and drops junk', () => {
  const s = sanitize({ a: 'x'.repeat(5000), b: NaN, c: () => 1, d: Array(100).fill(1) });
  assert.equal(s.a.length, 2000);
  assert.equal('b' in s, false);
  assert.equal('c' in s, false);
  assert.equal(s.d.length, 50);
});

test('client IP prefers CloudFront viewer address', () => {
  const ev = { headers: { 'cloudfront-viewer-address': '[2001:db8::1]:443', 'x-forwarded-for': '6.6.6.6' }, requestContext: { http: { sourceIp: '130.176.1.1' } } };
  assert.equal(clientIp(ev), '2001:db8::1');
  assert.equal(clientIp({ headers: { 'cloudfront-viewer-address': '198.51.100.4:5678' } }), '198.51.100.4');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '6.6.6.6' }, requestContext: { http: { sourceIp: '1.2.3.4' } } }), '1.2.3.4');
});

test('device description', () => {
  assert.equal(
    describeDevice({}, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'),
    'iPhone · iOS 18.1 · Safari 18.1',
  );
  assert.equal(
    describeDevice({ uaData: { model: 'Pixel 9', platform: 'Android', platformVersion: '15.0.0', fullVersionList: [{ brand: 'Not)A;Brand', version: '99' }, { brand: 'Google Chrome', version: '130.0.1' }] } }),
    'Pixel 9 · Android 15.0.0 · Google Chrome 130',
  );
  assert.equal(esc('<a&b>'), '&lt;a&amp;b&gt;');
});

test('visit notification mentions WebRTC IPs that differ from the HTTP IP', () => {
  const msg = visitMessage({
    id: 'x', createdAt: new Date().toISOString(),
    server: { ip: '1.1.1.1', headers: {} },
    client: { webrtc: { publicIps: ['1.1.1.1', '9.9.9.9'] }, visitCount: 3 },
  });
  assert.match(msg, /9\.9\.9\.9/);
  assert.match(msg, /visit #3/);
});
