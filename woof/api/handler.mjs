// Single Lambda function behind API Gateway (HTTP API, payload v2) or a
// Lambda Function URL — both send the same event shape.
//
//   POST /api/visit                 every page load: fingerprint -> { id, approx }
//   POST /api/visit/{id}/location   precise browser location for that visit
//   POST /api/found                 "I've found this dog" claim
//
// The "/api" prefix is optional so the function works both behind a CloudFront
// "/api/*" behaviour and on its own domain.

import { getStore } from './lib/store.mjs';
import { serverContext, approxLocation } from './lib/context.mjs';
import { sanitize, text, point, what3words, isId } from './lib/validate.mjs';
import { sendMessage, sendLocation, visitMessage, locationMessage, foundMessage } from './lib/notify.mjs';
import { toCoordinates } from './lib/w3w.mjs';

const MAX_BODY = 64 * 1024;

export async function handler(event) {
  const method = event.requestContext?.http?.method || event.httpMethod || 'GET';
  const path = (event.rawPath || event.path || '/').replace(/^\/api(?=\/)/, '').replace(/\/+$/, '') || '/';

  if (method === 'OPTIONS') return respond(204);

  try {
    if (method === 'POST' && path === '/visit') return await visit(event);
    const m = path.match(/^\/visit\/([^/]+)\/location$/);
    if (method === 'POST' && m) return await visitLocation(event, m[1]);
    if (method === 'POST' && path === '/found') return await found(event);
    if (method === 'GET' && path === '/health') return respond(200, { ok: true });
    return respond(404, { error: 'not found' });
  } catch (err) {
    if (err.statusCode) return respond(err.statusCode, { error: err.message });
    console.error(err);
    return respond(500, { error: 'internal error' });
  }
}

async function visit(event) {
  const body = parseBody(event);
  const now = new Date().toISOString();
  const item = {
    id: crypto.randomUUID(),
    type: 'visit',
    createdAt: now,
    server: await serverContext(event),
    client: sanitize(body.client) || {},
    locations: [],
  };
  await getStore().put(item);
  await sendMessage(visitMessage(item));
  return respond(201, { id: item.id, approx: approxLocation(item.server) });
}

async function visitLocation(event, id) {
  if (!isId(id)) throw httpError(400, 'bad id');
  const body = parseBody(event);
  const loc = point(body.location);
  if (!loc) throw httpError(400, 'bad location');
  const now = new Date().toISOString();
  loc.receivedAt = now;
  if (body.error) loc.error = text(body.error, 200);

  const item = await getStore().appendLocation(id, loc, now);
  if (!item) throw httpError(404, 'unknown visit');

  await sendLocation(loc.lat, loc.lon, loc.accuracy);
  await sendMessage(locationMessage(item, loc));
  return respond(200, { ok: true });
}

async function found(event) {
  const body = parseBody(event);
  const now = new Date().toISOString();

  const currentW3W = what3words(body.currentW3W);
  const foundW3W = what3words(body.foundW3W);
  const foundSameAsCurrent = body.foundSameAsCurrent !== false;

  const item = {
    id: crypto.randomUUID(),
    type: 'found',
    createdAt: now,
    visitId: isId(body.visitId) ? body.visitId : undefined,
    current: point(body.current),
    currentW3W,
    foundSameAsCurrent,
    found: foundSameAsCurrent ? undefined : point(body.found),
    foundW3W: foundSameAsCurrent ? undefined : foundW3W,
    finder: {
      name: text(body.name, 100),
      phone: text(body.phone, 40),
      message: text(body.message, 1000),
    },
    server: await serverContext(event),
    client: sanitize(body.client) || {},
  };

  // Something actionable is required, otherwise it's just noise.
  const f = item.finder;
  if (!item.current && !item.currentW3W && !item.found && !item.foundW3W && !f.phone && !f.message) {
    throw httpError(400, 'Please add a location, a phone number or a message.');
  }

  // Resolve what3words to coordinates if we have an API key and no pin.
  if (!item.current && item.currentW3W) item.currentFromW3W = await toCoordinates(item.currentW3W);
  if (!item.found && item.foundW3W) item.foundFromW3W = await toCoordinates(item.foundW3W);

  await getStore().put(stripUndefined(item));
  await sendMessage(foundMessage(item));
  const here = item.current || item.currentFromW3W;
  const there = item.found || item.foundFromW3W;
  if (there) await sendLocation(there.lat, there.lon, there.accuracy);
  if (here) await sendLocation(here.lat, here.lon, here.accuracy);
  return respond(201, { id: item.id });
}

// ---------------------------------------------------------------------------

function parseBody(event) {
  let raw = event.body || '';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  if (raw.length > MAX_BODY) throw httpError(413, 'payload too large');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw httpError(400, 'invalid JSON');
  }
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function stripUndefined(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      // Only needed if the API is on a different origin from the site. Behind
      // a single CloudFront distribution (recommended) it is same-origin.
      'access-control-allow-origin': process.env.ALLOWED_ORIGIN || '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    },
    body: body === undefined ? '' : JSON.stringify(body),
  };
}
