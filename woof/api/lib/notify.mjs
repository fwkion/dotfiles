// Phone notifications via a Telegram bot.
//
// Env:
//   TELEGRAM_BOT_TOKEN  token from @BotFather
//   TELEGRAM_CHAT_IDS   comma-separated chat ids (a group with both of you
//                       in it is easiest: one id, everyone gets pinged)
//   DISPLAY_TZ          time zone for timestamps in messages (default Europe/London)
//   DOG_NAME            only used in *your* notifications, never on the page
//
// Without a token, messages are printed to the console (local dev).
// Sending never throws: a Telegram outage must not lose the stored record.

const API = 'https://api.telegram.org';

function config() {
  return {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chats: (process.env.TELEGRAM_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

async function call(method, params, { fetchImpl = fetch } = {}) {
  const { token, chats } = config();
  if (!token || chats.length === 0) {
    console.log(`[notify:${method}]`, method === 'sendMessage' ? `\n${params.text}\n` : JSON.stringify(params));
    return;
  }
  const results = await Promise.allSettled(
    chats.map(async (chat_id) => {
      const res = await fetchImpl(`${API}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id, ...params }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`telegram ${method} ${res.status}: ${await res.text()}`);
    }),
  );
  for (const r of results) if (r.status === 'rejected') console.error(r.reason);
}

export const sendMessage = (html, opts) =>
  call('sendMessage', { text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }, opts);

export const sendLocation = (lat, lon, accuracy, opts) =>
  call(
    'sendLocation',
    { latitude: lat, longitude: lon, ...(accuracy ? { horizontal_accuracy: Math.min(1500, Math.round(accuracy)) } : {}) },
    opts,
  );

// ---------------------------------------------------------------------------
// Formatting

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const dog = () => esc(process.env.DOG_NAME || 'the dog');

function when(iso) {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: process.env.DISPLAY_TZ || 'Europe/London',
      dateStyle: 'medium',
      timeStyle: 'medium',
    });
  } catch {
    return iso;
  }
}

const mapsLink = (lat, lon, label = 'map') =>
  `<a href="https://maps.google.com/?q=${lat},${lon}">${esc(label)}</a>`;
const w3wLink = (words) => `<a href="https://what3words.com/${encodeURIComponent(words)}">///${esc(words)}</a>`;
const metres = (m) => (Number.isFinite(m) ? `±${m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km'}` : '');

/** "iPhone · iOS 18.1 · Safari 18.1" from client hints, falling back to the UA string. */
export function describeDevice(client = {}, ua = '') {
  ua = client.userAgent || ua || '';
  const hints = client.uaData || {};
  let device, os, browser;

  if (hints.model) device = hints.model;
  if (hints.platform) os = [hints.platform, String(hints.platformVersion || '').replace(/_/g, '.')].filter(Boolean).join(' ');
  const brands = (hints.fullVersionList || hints.brands || []).filter((b) => !/not.?a.?brand|chromium/i.test(b.brand));
  if (brands.length) browser = `${brands[0].brand} ${String(brands[0].version).split('.')[0]}`;

  let m;
  if (!device) {
    if (/iPhone/.test(ua)) device = 'iPhone';
    else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && client.maxTouchPoints > 1)) device = 'iPad';
    else if ((m = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/))) device = m[1] === 'K' ? 'Android' : m[1];
  }
  if (!os) {
    if ((m = ua.match(/(?:iPhone|CPU) OS (\d+[_\d]*)/))) os = `iOS ${m[1].replace(/_/g, '.')}`;
    else if ((m = ua.match(/Android ([\d.]+)/))) os = `Android ${m[1]}`;
    else if ((m = ua.match(/Windows NT ([\d.]+)/))) os = `Windows NT ${m[1]}`;
    else if ((m = ua.match(/Mac OS X ([\d_]+)/))) os = `macOS ${m[1].replace(/_/g, '.')}`;
    else if (/Linux/.test(ua)) os = 'Linux';
  }
  if (!browser) {
    const tests = [
      [/EdgA?\/(\d+)/, 'Edge'],
      [/OPR\/(\d+)/, 'Opera'],
      [/SamsungBrowser\/(\d+)/, 'Samsung Internet'],
      [/CriOS\/(\d+)/, 'Chrome'],
      [/FxiOS\/(\d+)/, 'Firefox'],
      [/Firefox\/(\d+)/, 'Firefox'],
      [/Chrome\/(\d+)/, 'Chrome'],
      [/Version\/([\d.]+).*Safari/, 'Safari'],
    ];
    for (const [re, name] of tests) if ((m = ua.match(re))) { browser = `${name} ${m[1]}`; break; }
  }
  if (/FBAN|FBAV/.test(ua)) browser = `Facebook app (${browser || '?'})`;
  else if (/Instagram/.test(ua)) browser = `Instagram app (${browser || '?'})`;
  return [device, os, browser].filter(Boolean).join(' · ') || ua.slice(0, 120) || 'unknown device';
}

function placeLine(g) {
  if (!g) return undefined;
  const place = [g.city, g.region, g.countryName || g.country].filter(Boolean).join(', ');
  const link = Number.isFinite(g.lat) && Number.isFinite(g.lon) ? ` (${mapsLink(g.lat, g.lon)})` : '';
  return place || link ? `${esc(place || 'somewhere')}${link}` : undefined;
}

function networkLine(server, client) {
  const ipInfo = server.ipInfo || {};
  const net = [ipInfo.isp || ipInfo.org, ipInfo.asn ? `AS${ipInfo.asn}` : server.cloudfront?.asn ? `AS${server.cloudfront.asn}` : '']
    .filter(Boolean)
    .join(' ');
  const conn = client.connection ? [client.connection.type, client.connection.effectiveType].filter(Boolean).join('/') : '';
  return [`<code>${esc(server.ip || '?')}</code>`, esc(net), conn && `(${esc(conn)})`].filter(Boolean).join(' ');
}

export function visitMessage(item) {
  const c = item.client || {};
  const s = item.server || {};
  const lines = [
    `👀 <b>Someone scanned ${dog()}'s tag</b>`,
    `🕒 ${esc(when(item.createdAt))}`,
    `📱 ${esc(describeDevice(c, s.headers?.['user-agent']))}`,
    `🌐 ${networkLine(s, c)}`,
  ];
  const approx = placeLine(s.cloudfront) || placeLine(s.ipInfo);
  if (approx) lines.push(`📍 Approx. (from IP): ${approx}`);
  const extra = [c.languages?.[0] || c.language, c.timeZone].filter(Boolean).join(' · ');
  if (extra) lines.push(`🗣 ${esc(extra)}`);
  if (c.webrtc?.publicIps?.length) {
    const others = c.webrtc.publicIps.filter((ip) => ip !== s.ip);
    if (others.length) lines.push(`🕵️ Other IPs seen via WebRTC: <code>${esc(others.join(', '))}</code>`);
  }
  if (c.visitCount > 1) lines.push(`🔁 Returning visitor (visit #${esc(c.visitCount)} from this browser)`);
  if (c.webdriver) lines.push('🤖 Browser reports automation (probably a bot)');
  if (c.query && Object.keys(c.query).length) lines.push(`🏷 ${esc(new URLSearchParams(c.query).toString())}`);
  lines.push(`<i>Will send a precise location if they allow it.</i>`, `<code>${esc(item.id)}</code>`);
  return lines.join('\n');
}

export function locationMessage(item, loc) {
  const c = item.client || {};
  return [
    `🎯 <b>Precise location of the person who scanned ${dog()}'s tag</b> ${esc(metres(loc.accuracy))}`,
    `📱 ${esc(describeDevice(c, item.server?.headers?.['user-agent']))}`,
    `${mapsLink(loc.lat, loc.lon, `${loc.lat}, ${loc.lon}`)}`,
    `<code>${esc(item.id)}</code>`,
  ].join('\n');
}

function placeDescription(label, p, words) {
  const parts = [];
  if (p) {
    const how = p.source === 'device' ? 'from their phone' : p.source === 'map' ? 'pinned on the map' : p.source || '';
    parts.push(`${mapsLink(p.lat, p.lon, `${p.lat}, ${p.lon}`)} ${esc(metres(p.accuracy))} ${how ? `<i>(${esc(how)})</i>` : ''}`.trim());
  }
  if (words) parts.push(w3wLink(words));
  return `${label}\n   ${parts.length ? parts.join('\n   ') : '<i>not given</i>'}`;
}

export function foundMessage(item) {
  const f = item.finder || {};
  const lines = [`🚨🐶 <b>SOMEONE SAYS THEY'VE FOUND ${dog().toUpperCase()}!</b>`, `🕒 ${esc(when(item.createdAt))}`, ''];
  if (f.name) lines.push(`👤 ${esc(f.name)}`);
  if (f.phone) lines.push(`📞 ${esc(f.phone)}`);
  if (f.message) lines.push(`💬 ${esc(f.message)}`);
  if (!f.phone) lines.push('⚠️ <i>No phone number left. Check the location below.</i>');
  lines.push('');
  lines.push(placeDescription('📍 <b>Where they are now:</b>', item.current, item.currentW3W));
  if (item.foundSameAsCurrent) lines.push('🐾 <b>Where they found him:</b> same place');
  else lines.push(placeDescription('🐾 <b>Where they found him:</b>', item.found, item.foundW3W));
  lines.push('', `🌐 <code>${esc(item.server?.ip || '?')}</code> · ${esc(describeDevice(item.client, item.server?.headers?.['user-agent']))}`);
  if (item.visitId) lines.push(`visit <code>${esc(item.visitId)}</code>`);
  lines.push(`<code>${esc(item.id)}</code>`);
  return lines.join('\n');
}
