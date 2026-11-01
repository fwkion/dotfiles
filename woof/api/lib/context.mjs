// Server-side view of a request: the visitor's IP address, the request
// headers worth keeping, CloudFront's geo headers (when the API sits behind
// CloudFront) and an optional IP -> location/ISP lookup.

// Headers kept verbatim on every record. Anything starting with one of the
// prefixes is kept too.
const KEEP_HEADERS = new Set([
  'user-agent',
  'accept-language',
  'accept',
  'referer',
  'origin',
  'dnt',
  'sec-gpc',
  'save-data',
  'x-forwarded-for',
  'x-forwarded-proto',
  'via',
]);
const KEEP_PREFIXES = ['sec-ch-', 'cloudfront-', 'sec-fetch-'];

export function requestHeaders(event) {
  const out = {};
  for (const [k, v] of Object.entries(event.headers || {})) {
    const key = k.toLowerCase();
    if (KEEP_HEADERS.has(key) || KEEP_PREFIXES.some((p) => key.startsWith(p))) {
      out[key] = String(v).slice(0, 1000);
    }
  }
  return out;
}

/**
 * Best guess at the visitor's public IP.
 * - Behind CloudFront: CloudFront-Viewer-Address ("ip:port", set by CloudFront,
 *   can't be spoofed by the client).
 * - API Gateway / Lambda Function URL directly: requestContext sourceIp.
 * X-Forwarded-For is recorded separately but never trusted on its own.
 */
export function clientIp(event, headers = requestHeaders(event)) {
  const viewer = headers['cloudfront-viewer-address'];
  if (viewer) return viewer.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return event.requestContext?.http?.sourceIp || event.requestContext?.identity?.sourceIp || undefined;
}

/** CloudFront geolocation headers, if the origin request policy forwards them. */
export function cloudfrontGeo(headers) {
  const h = (k) => headers[`cloudfront-viewer-${k}`];
  const lat = Number(h('latitude'));
  const lon = Number(h('longitude'));
  const geo = {
    country: h('country'),
    countryName: h('country-name'),
    region: h('country-region-name') || h('country-region'),
    city: h('city'),
    postalCode: h('postal-code'),
    timeZone: h('time-zone'),
    asn: h('asn'),
    lat: Number.isFinite(lat) && h('latitude') ? lat : undefined,
    lon: Number.isFinite(lon) && h('longitude') ? lon : undefined,
  };
  return Object.values(geo).some((v) => v !== undefined) ? strip(geo) : undefined;
}

/**
 * Look the IP up with a free geo-IP service to get city, ISP and ASN
 * (tells you e.g. "Vodafone mobile" vs "BT home broadband").
 * Disabled with IP_LOOKUP=off. Never throws; gives up after 1.5s.
 */
export async function ipLookup(ip, { fetchImpl = fetch } = {}) {
  if (!ip || (process.env.IP_LOOKUP || 'on') === 'off') return undefined;
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i.test(ip)) return undefined;
  try {
    const res = await fetchImpl(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      signal: AbortSignal.timeout(1500),
    });
    const j = await res.json();
    if (!j || j.success === false) return undefined;
    return strip({
      provider: 'ipwho.is',
      type: j.type,
      country: j.country_code,
      countryName: j.country,
      region: j.region,
      city: j.city,
      postalCode: j.postal,
      lat: j.latitude,
      lon: j.longitude,
      timeZone: j.timezone?.id,
      asn: j.connection?.asn,
      org: j.connection?.org,
      isp: j.connection?.isp,
      domain: j.connection?.domain,
    });
  } catch {
    return undefined;
  }
}

function strip(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

/** Everything the server knows about the request, for storing. */
export async function serverContext(event) {
  const headers = requestHeaders(event);
  const ip = clientIp(event, headers);
  return strip({
    ip,
    sourceIp: event.requestContext?.http?.sourceIp,
    headers,
    cloudfront: cloudfrontGeo(headers),
    ipInfo: await ipLookup(ip),
  });
}

/** Best approximate location we have without asking the visitor. */
export function approxLocation(server) {
  for (const g of [server.cloudfront, server.ipInfo]) {
    if (g && Number.isFinite(g.lat) && Number.isFinite(g.lon)) {
      return { lat: g.lat, lon: g.lon, city: g.city, region: g.region, country: g.countryName || g.country };
    }
  }
  return undefined;
}
