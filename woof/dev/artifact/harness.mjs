// Test console, part 2: runs the real API handler in the page.
// Records go to the artifact's shared database (visits/, found/), and every
// notification the Lambda would send to Telegram goes to notifications/ and
// shows up in the "Your phone" feed instead.

import { handler } from './api/handler.mjs';
import { setStore } from './api/lib/store.mjs';
import { setTransport } from './api/lib/notify.mjs';

const $ = (id) => document.getElementById(id);
const woof = window.__woof;

// ---------------------------------------------------------------------------
// Storage: artifact db when available, otherwise this tab's memory.

const memory = { visits: new Map(), found: new Map(), notifications: [] };
let db = null;

function plain(obj) {
  return JSON.parse(JSON.stringify(obj));
}

const store = {
  async put(item) {
    const coll = item.type === 'found' ? 'found' : 'visits';
    if (db) await db.doc(`${coll}/${item.id}`).set(plain(item));
    else memory[coll].set(item.id, plain(item));
    if (!db) renderRecord();
  },
  async appendLocation(id, location, now) {
    if (!db) {
      const item = memory.visits.get(id);
      if (!item) return undefined;
      item.locations = [...(item.locations || []), location];
      item.updatedAt = now;
      renderRecord();
      return item;
    }
    const ref = db.doc(`visits/${id}`);
    const snap = await ref.get();
    if (!snap.exists) return undefined;
    const item = plain(snap.data());
    item.locations = [...(item.locations || []), location];
    item.updatedAt = now;
    await ref.update({ locations: item.locations, updatedAt: now });
    return item;
  },
};

// Telegram calls become feed entries.
let seq = 0;
setTransport(async (method, params) => {
  const entry = {
    at: new Date().toISOString(),
    seq: seq++,
    method,
    text: method === 'sendMessage' ? params.text : undefined,
    lat: params.latitude,
    lon: params.longitude,
    accuracy: params.horizontal_accuracy,
  };
  if (db) await db.collection('notifications').add(plain(entry));
  else { memory.notifications.unshift(plain(entry)); renderFeed(memory.notifications); }
});

setStore(store);

// Wait (briefly) for the db so the first visit lands in it.
const dbReady = (async () => {
  try {
    const use = window.claude && window.claude.use;
    if (!use) return null;
    return await Promise.race([use('db'), new Promise((r) => setTimeout(() => r(null), 4000))]);
  } catch {
    return null;
  }
})();

db = await dbReady;
woof.setApi({ handler });
setStorageNote();
if (db) subscribe();
else renderFeed([]);

// ---------------------------------------------------------------------------
// Feed

function setStorageNote() {
  $('tc-storage').textContent = db
    ? 'Saved to this artifact\'s database. Everyone testing sees the same feed.'
    : 'Saved in this tab only (no shared database here). Records vanish on reload.';
}

function subscribe() {
  const loading = setTimeout(() => { $('tc-feed-note').textContent = 'Still loading notifications…'; }, 10000);
  db.collection('notifications').orderBy('at', 'desc').limit(60).onSnapshot(
    (snap) => {
      if (!snap.metadata.fromCache) { clearTimeout(loading); $('tc-feed-note').textContent = ''; }
      renderFeed(snap.docs.map((d) => d.data()));
    },
    () => { clearTimeout(loading); $('tc-feed-note').textContent = 'Couldn\'t load notifications.'; },
  );
  db.collection('visits').orderBy('createdAt', 'desc').limit(1).onSnapshot(
    (snap) => renderRecord(snap.docs[0] && snap.docs[0].data()),
    () => {},
  );
  db.collection('found').orderBy('createdAt', 'desc').limit(1).onSnapshot(
    (snap) => renderClaim(snap.docs[0] && snap.docs[0].data()),
    () => {},
  );
}

// Telegram's HTML subset, rebuilt from a parse so nothing else gets through.
function safeHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const out = document.createDocumentFragment();
  const walk = (node, parent) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) { parent.append(child.textContent); continue; }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName.toLowerCase();
      let el;
      if (tag === 'b' || tag === 'i' || tag === 'code') el = document.createElement(tag);
      else if (tag === 'a' && /^https:\/\//.test(child.getAttribute('href') || '')) {
        el = document.createElement('a');
        el.href = child.getAttribute('href');
        el.target = '_blank';
        el.rel = 'noopener';
      }
      if (el) { walk(child, el); parent.append(el); } else walk(child, parent);
    }
  };
  walk(tpl.content, out);
  return out;
}

function timeOf(iso) {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return ''; }
}

function renderFeed(items) {
  const feed = $('tc-feed');
  feed.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'tc-empty';
    empty.textContent = 'No notifications yet. Each page load sends one; allow location or submit the form to see more.';
    feed.append(empty);
    return;
  }
  const sorted = [...items].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : (b.seq || 0) - (a.seq || 0)));
  for (const n of sorted) {
    const bubble = document.createElement('article');
    bubble.className = 'tc-msg' + (n.text && n.text.includes('FOUND') ? ' tc-alert' : '');
    if (n.method === 'sendLocation') {
      bubble.classList.add('tc-pin');
      const a = document.createElement('a');
      a.href = `https://maps.google.com/?q=${n.lat},${n.lon}`;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = `${Number(n.lat).toFixed(5)}, ${Number(n.lon).toFixed(5)}`;
      const label = document.createElement('span');
      label.className = 'tc-pin-label';
      label.textContent = 'Location pin' + (n.accuracy ? ` · ±${n.accuracy} m` : '');
      bubble.append(label, a);
    } else {
      const body = document.createElement('div');
      body.className = 'tc-text';
      body.append(safeHtml(n.text || ''));
      bubble.append(body);
    }
    const t = document.createElement('time');
    t.textContent = timeOf(n.at);
    bubble.append(t);
    feed.append(bubble);
  }
}

function renderRecord(item) {
  if (!item && !db) item = [...memory.visits.values()].pop();
  $('tc-record').textContent = item ? JSON.stringify(item, null, 2) : 'No visits recorded yet.';
}
function renderClaim(item) {
  $('tc-claim').textContent = item ? JSON.stringify(item, null, 2) : 'No claims yet.';
}
renderRecord();
renderClaim();

// ---------------------------------------------------------------------------
// Location prompt controls

const g = woof.geo;
function readPos() {
  const lat = Number($('tc-lat').value);
  const lon = Number($('tc-lon').value);
  const acc = Number($('tc-acc').value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    $('tc-geo-status').textContent = 'Enter a latitude between -90 and 90 and a longitude between -180 and 180.';
    return null;
  }
  return { lat, lon, accuracy: Number.isFinite(acc) && acc > 0 ? acc : 25 };
}

function renderGeo() {
  const s = g.state;
  const pending = g.pending();
  $('tc-allow').hidden = s.decision !== null;
  $('tc-deny').hidden = s.decision !== null;
  $('tc-move').hidden = s.decision !== 'granted';
  $('tc-move').disabled = g.watching() === 0;
  $('tc-geo').dataset.state = pending ? 'asking' : s.decision || 'idle';
  $('tc-geo-status').textContent =
    s.decision === 'granted' ? (g.watching() ? 'Allowed. The page is still refining its position, so you can send a better fix.' : 'Allowed. The page has stopped tracking.')
    : s.decision === 'denied' ? 'Blocked. Reload to see the prompt again.'
    : pending ? 'The page is asking for the visitor\'s location.'
    : 'No location request yet.';
}
g.onChange(renderGeo);
renderGeo();

$('tc-allow').onclick = () => { const p = readPos(); if (p) g.allow(p); };
$('tc-deny').onclick = () => g.deny();
$('tc-move').onclick = () => {
  const p = readPos();
  if (!p) return;
  p.accuracy = Math.max(3, Math.round(p.accuracy / 3));
  $('tc-acc').value = p.accuracy;
  g.move(p);
};
$('tc-reload').onclick = () => location.reload();

// ---------------------------------------------------------------------------
// Clear test data (two-step, no dialogs in the sandbox)

let armed = null;
$('tc-clear').onclick = async () => {
  const btn = $('tc-clear');
  if (!armed) {
    btn.textContent = 'Click again to delete all test records';
    btn.classList.add('tc-danger');
    armed = setTimeout(() => { armed = null; btn.textContent = 'Clear test data'; btn.classList.remove('tc-danger'); }, 4000);
    return;
  }
  clearTimeout(armed);
  armed = null;
  btn.disabled = true;
  btn.textContent = 'Clearing…';
  try {
    if (db) {
      for (const coll of ['notifications', 'visits', 'found']) {
        const snap = await db.collection(coll).limit(1000).get();
        for (const d of snap.docs) await db.doc(`${coll}/${d.id}`).delete();
      }
    } else {
      memory.visits.clear(); memory.found.clear(); memory.notifications.length = 0;
      renderFeed([]); renderRecord(); renderClaim();
    }
    btn.textContent = 'Cleared';
  } catch (e) {
    btn.textContent = 'Couldn\'t clear: ' + (e.code || e.message || 'error');
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = 'Clear test data'; btn.classList.remove('tc-danger'); }, 2000);
};

$('tc-jump').onclick = () => $('tc').scrollIntoView({ behavior: 'smooth' });
// Hide the phone-width "jump to console" button once the console is on screen.
if ('IntersectionObserver' in window) {
  new IntersectionObserver(([e]) => { $('tc-jump').hidden = e.isIntersecting; }).observe($('tc'));
}
