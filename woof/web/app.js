(function () {
  'use strict';

  var cfg = window.WOOF_CONFIG || {};
  var API = (cfg.apiBase || '/api').replace(/\/+$/, '');
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    visitId: null,
    approx: null,        // rough location from IP, returned by the API
    position: null,      // latest device (GPS/Wi-Fi) fix
    sentLocations: [],   // fixes already sent for this visit
    client: null,
    watchId: null,
  };

  // ---------------------------------------------------------------------------
  // API

  function post(path, body) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true, // survive the visitor closing the tab
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) throw new Error(json.error || 'HTTP ' + res.status);
        return json;
      });
    });
  }

  function retry(fn, attempts, delay) {
    return fn().catch(function (err) {
      if (attempts <= 1) throw err;
      return new Promise(function (r) { setTimeout(r, delay); }).then(function () { return retry(fn, attempts - 1, delay * 2); });
    });
  }

  // 1. Record the visit as soon as the page loads.
  var visitReady = window.collectFingerprint(2000)
    .catch(function () { return { userAgent: navigator.userAgent, fingerprintError: true }; })
    .then(function (fp) {
      state.client = fp;
      return retry(function () { return post('/visit', { client: fp }); }, 3, 1500);
    })
    .then(function (res) {
      state.visitId = res.id;
      state.approx = res.approx || null;
      if (!state.position && pickers.here) pickers.here.centerOn(state.approx, 13);
      return res.id;
    });
  visitReady.catch(function (err) { console.warn('visit not recorded', err); });

  // ---------------------------------------------------------------------------
  // 2. Precise location (needs the visitor's permission)

  function toPoint(pos) {
    var c = pos.coords;
    return {
      lat: c.latitude, lon: c.longitude, accuracy: c.accuracy,
      altitude: c.altitude, altitudeAccuracy: c.altitudeAccuracy,
      heading: c.heading, speed: c.speed, timestamp: pos.timestamp, source: 'device',
    };
  }

  // Send the first fix, then up to two more if accuracy improves a lot
  // (first fixes are often coarse Wi-Fi/cell positions).
  function maybeSendLocation(p) {
    var sent = state.sentLocations;
    var last = sent[sent.length - 1];
    if (last && (sent.length >= 3 || !(p.accuracy < last.accuracy / 2))) return;
    sent.push(p);
    visitReady.then(function (id) {
      return retry(function () { return post('/visit/' + id + '/location', { location: p }); }, 3, 1500);
    }).catch(function (err) { console.warn('location not sent', err); });
  }

  function setStatus(msg) { $('loc-status').textContent = msg || ''; }

  function showBanner(text, buttonLabel) {
    $('loc-banner-text').textContent = text;
    $('loc-btn').textContent = buttonLabel || 'Share my location';
    $('loc-banner').hidden = false;
  }

  function startLocation() {
    if (!('geolocation' in navigator)) {
      setStatus('');
      showBanner('📍 Your browser can\'t share its location, but you can still point to where you are on the map.', 'Open the form');
      $('loc-btn').onclick = openForm;
      return;
    }
    if (state.watchId !== null) return;
    setStatus('📍 Finding your location…');
    $('here-gps').disabled = true;

    state.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 20000,
    });
    // Keep refining for a while, then stop to save battery.
    setTimeout(stopLocation, 45000);
  }

  function stopLocation() {
    if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    $('here-gps').disabled = false;
  }

  function onPosition(pos) {
    var p = toPoint(pos);
    state.position = p;
    $('loc-banner').hidden = true;
    setStatus('✅ Thank you! My family can see where I am (±' + Math.round(p.accuracy) + ' m).');
    $('here-gps').disabled = false;
    if (pickers.here) pickers.here.setFromDevice(p);
    maybeSendLocation(p);
  }

  function onPositionError(err) {
    if (state.position) return; // already have a fix; ignore later hiccups
    stopLocation();
    setStatus('');
    if (err.code === 1) {
      showBanner(
        '📍 Location sharing is off. If you\'ve found me, you can still show my family where you are on the map.',
        'Try sharing location again'
      );
    } else {
      showBanner('📍 Couldn\'t get your location just now.', 'Try again');
    }
  }

  $('loc-btn').onclick = startLocation;

  // ---------------------------------------------------------------------------
  // Maps (Leaflet + OpenStreetMap)

  var pickers = {};

  function makePicker(el, coordsEl) {
    var map = L.map(el, { zoomControl: true, tap: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    map.setView(cfg.defaultMapCenter || [54.5, -3], cfg.defaultMapZoom || 5);

    var marker = null, circle = null, point = null, manual = false;

    function render() {
      coordsEl.textContent = point
        ? (point.source === 'device' ? '📍 Your location' : '📌 Pinned') + ': ' + point.lat.toFixed(5) + ', ' + point.lon.toFixed(5) +
          (point.accuracy ? ' (±' + Math.round(point.accuracy) + ' m)' : '')
        : 'No location yet';
    }

    function place(p) {
      point = p;
      var ll = [p.lat, p.lon];
      if (!marker) {
        marker = L.marker(ll, { draggable: true, autoPan: true }).addTo(map);
        marker.on('dragend', function () {
          var m = marker.getLatLng();
          manual = true;
          place({ lat: m.lat, lon: m.lng, source: 'map' });
        });
      } else {
        marker.setLatLng(ll);
      }
      if (circle) { circle.remove(); circle = null; }
      if (p.accuracy && p.accuracy < 5000) {
        circle = L.circle(ll, { radius: p.accuracy, weight: 1, color: '#f59e0b', fillOpacity: 0.12 }).addTo(map);
      }
      render();
    }

    map.on('click', function (e) {
      manual = true;
      place({ lat: e.latlng.lat, lon: e.latlng.lng, source: 'map' });
    });

    render();
    return {
      map: map,
      get: function () { return point; },
      // Device fixes never overwrite a pin the visitor placed by hand.
      setFromDevice: function (p) {
        if (manual) return;
        place(p);
        map.setView([p.lat, p.lon], Math.max(map.getZoom(), 17));
      },
      // "Use my current location": follow device fixes again.
      useDevice: function () { manual = false; },
      centerOn: function (p, zoom) { if (p && !point) map.setView([p.lat, p.lon], zoom); },
    };
  }

  function initHereMap() {
    if (pickers.here) { pickers.here.map.invalidateSize(); return; }
    pickers.here = makePicker($('map-here'), $('here-coords'));
    if (state.position) pickers.here.setFromDevice(state.position);
    else pickers.here.centerOn(state.approx, 13);
  }

  function initFoundMap() {
    if (pickers.found) { pickers.found.map.invalidateSize(); return; }
    pickers.found = makePicker($('map-found'), $('found-coords'));
    var here = pickers.here && pickers.here.get();
    if (here) pickers.found.map.setView([here.lat, here.lon], 16);
    else pickers.found.centerOn(state.approx, 13);
  }

  // ---------------------------------------------------------------------------
  // Views

  var views = ['home', 'found-form', 'thanks'];
  function show(view, push) {
    views.forEach(function (v) { $(v).hidden = v !== view; });
    window.scrollTo(0, 0);
    if (view === 'found-form') {
      initHereMap();
      if (!$('same-place').checked) initFoundMap();
    }
    if (push) history.pushState({ view: view }, '', '#' + (view === 'home' ? '' : view));
  }
  window.addEventListener('popstate', function (e) { show((e.state && e.state.view) || 'home'); });
  history.replaceState({ view: 'home' }, '', location.pathname + location.search);

  function openForm() {
    show('found-form', true);
    // If we don't have a fix yet, ask now: they've just told us they have him.
    if (!state.position) startLocation();
  }

  $('found-btn').onclick = openForm;
  document.querySelectorAll('[data-back]').forEach(function (b) {
    b.onclick = function () { history.back(); };
  });

  $('here-gps').onclick = function () {
    // Replace any hand-placed pin with the fix we already have, then refine.
    pickers.here.useDevice();
    if (state.position) pickers.here.setFromDevice(state.position);
    stopLocation();
    startLocation();
  };

  $('same-place').onchange = function () {
    $('found-elsewhere').hidden = this.checked;
    if (!this.checked) initFoundMap();
  };

  // ---------------------------------------------------------------------------
  // Submit claim

  var W3W = /^\/{0,3}\s*[^\s.\/]+[.\s。｡・·][^\s.\/]+[.\s。｡・·][^\s.\/]+\s*$/;

  function w3wValue(id) {
    var v = $(id).value.trim();
    return v ? v : undefined;
  }

  function fail(msg) {
    var el = $('form-error');
    el.textContent = msg;
    el.hidden = false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  $('found-form').addEventListener('submit', function (e) {
    e.preventDefault();
    $('form-error').hidden = true;

    var same = $('same-place').checked;
    var payload = {
      visitId: state.visitId,
      current: pickers.here && pickers.here.get(),
      currentW3W: w3wValue('here-w3w'),
      foundSameAsCurrent: same,
      found: !same && pickers.found ? pickers.found.get() : undefined,
      foundW3W: !same ? w3wValue('found-w3w') : undefined,
      name: $('name').value,
      phone: $('phone').value,
      message: $('message').value,
      client: state.client && {
        visitorId: state.client.visitorId,
        fingerprint: state.client.fingerprint,
        userAgent: state.client.userAgent,
      },
    };

    if (payload.currentW3W && !W3W.test(payload.currentW3W)) return fail('That what3words address doesn\'t look right. It should be three words like filled.count.soap');
    if (payload.foundW3W && !W3W.test(payload.foundW3W)) return fail('The "where you found me" what3words address doesn\'t look right.');
    if (!payload.current && !payload.currentW3W && !payload.found && !payload.foundW3W && !payload.phone.trim() && !payload.message.trim()) {
      return fail('Please pin your location on the map or leave a phone number so my family can find us.');
    }

    var btn = $('submit-btn');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    retry(function () { return post('/found', payload); }, 3, 1000)
      .then(function () { show('thanks', true); })
      .catch(function () {
        fail(cfg.ownerPhone
          ? 'Sorry, that didn\'t send. Please call my family on ' + cfg.ownerPhone + '.'
          : 'Sorry, that didn\'t send. Please check your connection and try again.');
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = 'Let my family know';
      });
  });

  // ---------------------------------------------------------------------------
  // Optional config: photo + direct contact

  if (cfg.photoUrl) {
    $('photo').src = cfg.photoUrl;
    $('photo').hidden = false;
    $('paw').hidden = true;
  }
  if (cfg.ownerPhone) {
    var tel = 'tel:' + cfg.ownerPhone.replace(/[^\d+]/g, '');
    var wa = 'https://wa.me/' + cfg.ownerPhone.replace(/\D/g, '') + '?text=' + encodeURIComponent('Hi, I think I\'ve found your dog!');
    ['call-link', 'thanks-call'].forEach(function (id) { $(id).href = tel; });
    ['whatsapp-link', 'thanks-whatsapp'].forEach(function (id) { $(id).href = wa; });
    $('contact-direct').hidden = false;
    $('thanks-contact').hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Kick off location request

  if (cfg.autoRequestLocation !== false) {
    startLocation();
  } else {
    showBanner('📍 Sharing your location lets my family know where I am, even if you don\'t fill anything in.');
  }
})();
