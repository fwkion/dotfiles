// Test console, part 1: runs BEFORE config.js / app.js.
//
// The artifact sandbox has no Lambda, no geolocation and no outbound network,
// so this script:
//   - gives the API modules a `process.env`
//   - routes fetch('/api/...') to the real handler (loaded by harness.mjs)
//   - replaces navigator.geolocation with a fake whose permission prompt is
//     answered from the test console
(function () {
  'use strict';

  window.process = { env: { DOG_NAME: 'Ollie', IP_LOOKUP: 'off', DISPLAY_TZ: 'Europe/London' } };

  // What CloudFront would add in production, so the "approx. location from
  // IP" path is exercised. Documentation-range IP, clearly fake.
  var SIMULATED = {
    'cloudfront-viewer-address': '203.0.113.42:51234',
    'cloudfront-viewer-country': 'GB',
    'cloudfront-viewer-country-name': 'United Kingdom',
    'cloudfront-viewer-country-region-name': 'England',
    'cloudfront-viewer-city': 'London',
    'cloudfront-viewer-latitude': '51.5074',
    'cloudfront-viewer-longitude': '-0.1278',
    'cloudfront-viewer-time-zone': 'Europe/London',
    'cloudfront-viewer-asn': '5089',
  };

  var resolveApi;
  var apiReady = new Promise(function (r) { resolveApi = r; });
  window.__woof = { setApi: function (api) { resolveApi(api); }, simulatedHeaders: SIMULATED };

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.pathname.indexOf('/api/') !== 0) return realFetch(input, init);
    init = init || {};
    var headers = Object.assign({}, SIMULATED, {
      'user-agent': navigator.userAgent,
      'accept-language': (navigator.languages || [navigator.language]).join(','),
    });
    return apiReady.then(function (api) {
      return api.handler({
        version: '2.0',
        rawPath: url.pathname,
        headers: headers,
        body: init.body || '',
        requestContext: { http: { method: init.method || 'GET', sourceIp: '130.176.0.1' } },
      });
    }).then(function (r) {
      return new Response(r.statusCode === 204 ? null : r.body, { status: r.statusCode, headers: r.headers });
    });
  };

  // ---------------------------------------------------------------------------
  // Fake geolocation. The console decides: allow (with a position) or block.

  var geo = {
    decision: null,      // null = not asked yet, 'granted', 'denied'
    position: { lat: 51.5033, lon: -0.1196, accuracy: 25 },
    waiting: [],         // one-shot requests waiting for a decision
    watchers: {},
    nextId: 1,
    listeners: [],
  };

  function makePosition() {
    return {
      coords: {
        latitude: geo.position.lat, longitude: geo.position.lon, accuracy: geo.position.accuracy,
        altitude: null, altitudeAccuracy: null, heading: null, speed: null,
      },
      timestamp: Date.now(),
    };
  }
  function denied() { return { code: 1, message: 'User denied Geolocation', PERMISSION_DENIED: 1 }; }
  function emit() { geo.listeners.forEach(function (fn) { fn(); }); }

  function request(entry) {
    if (geo.decision === 'granted') setTimeout(function () { entry.ok(makePosition()); }, 300);
    else if (geo.decision === 'denied') setTimeout(function () { entry.err && entry.err(denied()); }, 50);
    else { geo.waiting.push(entry); emit(); }
  }

  var fake = {
    getCurrentPosition: function (ok, err) { request({ ok: ok, err: err }); },
    watchPosition: function (ok, err) {
      var id = geo.nextId++;
      geo.watchers[id] = { ok: ok, err: err };
      request(geo.watchers[id]);
      emit();
      return id;
    },
    clearWatch: function (id) { delete geo.watchers[id]; emit(); },
  };
  try {
    Object.defineProperty(navigator, 'geolocation', { value: fake, configurable: true });
  } catch (e) {
    console.warn('could not replace geolocation', e);
  }

  window.__woof.geo = {
    state: geo,
    onChange: function (fn) { geo.listeners.push(fn); },
    pending: function () { return geo.waiting.length > 0 || (geo.decision === null && Object.keys(geo.watchers).length > 0); },
    watching: function () { return Object.keys(geo.watchers).length; },
    allow: function (pos) {
      geo.position = pos;
      geo.decision = 'granted';
      var p = makePosition();
      geo.waiting.splice(0).forEach(function (e) { e.ok(p); });
      emit();
    },
    deny: function () {
      geo.decision = 'denied';
      geo.waiting.splice(0).forEach(function (e) { e.err && e.err(denied()); });
      emit();
    },
    // A later, usually more accurate, fix for pages still watching.
    move: function (pos) {
      geo.position = pos;
      var p = makePosition();
      Object.keys(geo.watchers).forEach(function (id) { geo.watchers[id].ok(p); });
      emit();
    },
  };
})();
