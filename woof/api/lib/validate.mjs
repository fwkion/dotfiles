// Input hygiene. Everything that arrives from the browser is untrusted:
// it is size-limited, depth-limited and coerced before it is stored or
// put into a notification.

const MAX_STRING = 2000;
const MAX_ARRAY = 50;
const MAX_KEYS = 100;
const MAX_DEPTH = 6;

/** Recursively copy a JSON value, truncating anything oversized. */
export function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return undefined;
  switch (typeof value) {
    case 'string':
      return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
    case 'number':
      return Number.isFinite(value) ? value : undefined;
    case 'boolean':
      return value;
    case 'object': {
      if (depth >= MAX_DEPTH) return undefined;
      if (Array.isArray(value)) {
        return value
          .slice(0, MAX_ARRAY)
          .map((v) => sanitize(v, depth + 1))
          .filter((v) => v !== undefined);
      }
      const out = {};
      for (const key of Object.keys(value).slice(0, MAX_KEYS)) {
        const v = sanitize(value[key], depth + 1);
        if (v !== undefined) out[key.slice(0, 100)] = v;
      }
      return out;
    }
    default:
      return undefined;
  }
}

/** Short free-text field (name, phone, message). */
export function text(value, max = 500) {
  if (typeof value !== 'string') return undefined;
  const t = value.trim().slice(0, max);
  return t || undefined;
}

function num(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * A geographic point as sent by the browser. Returns undefined when the
 * coordinates are missing or out of range.
 */
export function point(value) {
  if (!value || typeof value !== 'object') return undefined;
  const lat = num(value.lat);
  const lon = num(value.lon);
  if (lat === undefined || lon === undefined) return undefined;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return undefined;
  const p = { lat: round(lat, 7), lon: round(lon, 7) };
  for (const k of ['accuracy', 'altitude', 'altitudeAccuracy', 'heading', 'speed', 'timestamp']) {
    const v = num(value[k]);
    if (v !== undefined) p[k] = v;
  }
  const source = text(value.source, 40);
  if (source) p.source = source;
  return p;
}

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * Normalise a what3words address. Accepts "///a.b.c", "a.b.c",
 * "https://what3words.com/a.b.c" or "https://w3w.co/a.b.c".
 * Returns "a.b.c" or undefined.
 */
export function what3words(value) {
  if (typeof value !== 'string') return undefined;
  let s = value.trim().toLowerCase();
  s = s.replace(/^https?:\/\/(www\.)?(what3words\.com|w3w\.co)\//, '');
  s = s.replace(/^\/{1,3}/, '').replace(/[?#].*$/, '');
  s = s.replace(/[\s。｡・·]+/g, '.'); // tolerate spaces / CJK dots between words
  return /^\p{L}+\.\p{L}+\.\p{L}+$/u.test(s) ? s : undefined;
}

/** True if the id looks like one we issued (UUID v4). */
export function isId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
