// Collects everything a browser will tell us without asking permission.
// Each probe is time-boxed and failure-tolerant: the visit must be recorded
// even on old or locked-down browsers.
//
// Note: browsers do NOT expose Wi-Fi details (SSID, BSSID, nearby networks).
// The nearest things available are the Network Information API (connection
// type / speed, Chromium only), the public IP + ISP (looked up server-side) and
// WebRTC-discovered IPs.

(function () {
  'use strict';

  function withTimeout(promise, ms) {
    return Promise.race([
      Promise.resolve(promise).catch(function () { return undefined; }),
      new Promise(function (resolve) { setTimeout(resolve, ms); }),
    ]);
  }

  function safe(fn) {
    try { return fn(); } catch (e) { return undefined; }
  }

  // 32-bit FNV-1a, hex. Not cryptographic, just a stable short id.
  function hash(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function randomId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  // Persistent per-browser id + visit counter (localStorage, cookie fallback).
  function visitorInfo() {
    var id, count;
    try {
      id = localStorage.getItem('woof_vid');
      count = parseInt(localStorage.getItem('woof_visits') || '0', 10) + 1;
      if (!id) { id = randomId(); localStorage.setItem('woof_vid', id); }
      localStorage.setItem('woof_visits', String(count));
      var first = localStorage.getItem('woof_first');
      if (!first) { first = new Date().toISOString(); localStorage.setItem('woof_first', first); }
      return { visitorId: id, visitCount: count, firstVisit: first, storage: 'localStorage' };
    } catch (e) {
      var m = document.cookie.match(/(?:^|; )woof_vid=([^;]+)/);
      id = m ? m[1] : randomId();
      safe(function () { document.cookie = 'woof_vid=' + id + '; max-age=31536000; path=/; SameSite=Lax; Secure'; });
      return { visitorId: id, visitCount: m ? undefined : 1, storage: 'cookie' };
    }
  }

  function screenInfo() {
    var s = window.screen || {};
    return {
      width: s.width, height: s.height,
      availWidth: s.availWidth, availHeight: s.availHeight,
      colorDepth: s.colorDepth,
      pixelRatio: window.devicePixelRatio,
      viewport: [window.innerWidth, window.innerHeight],
      orientation: safe(function () { return s.orientation.type; }),
    };
  }

  function connectionInfo() {
    var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!c) return undefined;
    return { type: c.type, effectiveType: c.effectiveType, downlink: c.downlink, downlinkMax: c.downlinkMax, rtt: c.rtt, saveData: c.saveData };
  }

  function webglInfo() {
    return safe(function () {
      var canvas = document.createElement('canvas');
      var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return undefined;
      var info = { vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER) };
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        info.unmaskedVendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
        info.unmaskedRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
      }
      return info;
    });
  }

  function canvasHash() {
    return safe(function () {
      var c = document.createElement('canvas');
      c.width = 240; c.height = 60;
      var ctx = c.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '16px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(100, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('woof woof 🐶 ẞ ж 漢', 2, 15);
      ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
      ctx.fillText('woof woof 🐶 ẞ ж 漢', 4, 17);
      return hash(c.toDataURL());
    });
  }

  function userAgentData() {
    var d = navigator.userAgentData;
    if (!d) return undefined;
    var low = { brands: d.brands, mobile: d.mobile, platform: d.platform };
    if (!d.getHighEntropyValues) return Promise.resolve(low);
    return d.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'wow64', 'formFactors'])
      .then(function (high) { return Object.assign(low, high); })
      .catch(function () { return low; });
  }

  function battery() {
    if (!navigator.getBattery) return undefined;
    return navigator.getBattery().then(function (b) {
      return { level: b.level, charging: b.charging, chargingTime: b.chargingTime, dischargingTime: b.dischargingTime };
    });
  }

  function mediaDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return undefined;
    return navigator.mediaDevices.enumerateDevices().then(function (list) {
      var counts = {};
      list.forEach(function (d) { counts[d.kind] = (counts[d.kind] || 0) + 1; });
      return counts;
    });
  }

  function permissionState(name) {
    if (!navigator.permissions || !navigator.permissions.query) return undefined;
    return navigator.permissions.query({ name: name }).then(function (p) { return p.state; });
  }

  // WebRTC ICE gathering against a public STUN server reveals the public IP(s)
  // the device uses for UDP, which can differ from the HTTP one (VPN/proxy,
  // IPv4 vs IPv6, dual SIM...). Local IPs are hidden behind mDNS names by
  // modern browsers.
  function webrtcIps(ms) {
    var Peer = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (!Peer) return undefined;
    return new Promise(function (resolve) {
      var publicIps = {}, candidateTypes = {}, pc;
      function done() {
        safe(function () { pc.close(); });
        resolve({ publicIps: Object.keys(publicIps), candidateTypes: Object.keys(candidateTypes) });
      }
      try {
        pc = new Peer({ iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }] });
        pc.createDataChannel('woof');
        pc.onicecandidate = function (e) {
          if (!e.candidate) return done();
          var parts = e.candidate.candidate.split(' ');
          var ip = parts[4], type = parts[7];
          if (type) candidateTypes[type] = true;
          if (type === 'srflx' && ip) publicIps[ip] = true;
        };
        pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(done);
        setTimeout(done, ms);
      } catch (e) {
        resolve(undefined);
      }
    });
  }

  function queryParams() {
    var out = {};
    safe(function () { new URLSearchParams(location.search).forEach(function (v, k) { out[k] = v; }); });
    return out;
  }

  window.collectFingerprint = function (budgetMs) {
    budgetMs = budgetMs || 2000;
    var nav = navigator;
    var intl = safe(function () { return Intl.DateTimeFormat().resolvedOptions(); }) || {};

    var fp = Object.assign(visitorInfo(), {
      collectedAt: new Date().toISOString(),
      url: location.href,
      query: queryParams(),
      referrer: document.referrer || undefined,
      userAgent: nav.userAgent,
      platform: nav.platform,
      vendor: nav.vendor,
      language: nav.language,
      languages: nav.languages ? Array.prototype.slice.call(nav.languages) : undefined,
      timeZone: intl.timeZone,
      locale: intl.locale,
      timezoneOffset: new Date().getTimezoneOffset(),
      screen: screenInfo(),
      hardwareConcurrency: nav.hardwareConcurrency,
      deviceMemory: nav.deviceMemory,
      maxTouchPoints: nav.maxTouchPoints,
      cookieEnabled: nav.cookieEnabled,
      doNotTrack: nav.doNotTrack || window.doNotTrack,
      globalPrivacyControl: nav.globalPrivacyControl,
      pdfViewerEnabled: nav.pdfViewerEnabled,
      webdriver: nav.webdriver,
      standalone: nav.standalone,
      online: nav.onLine,
      connection: connectionInfo(),
      webgl: webglInfo(),
      canvasHash: canvasHash(),
      prefersDark: safe(function () { return matchMedia('(prefers-color-scheme: dark)').matches; }),
      prefersReducedMotion: safe(function () { return matchMedia('(prefers-reduced-motion: reduce)').matches; }),
    });

    var probes = {
      uaData: userAgentData(),
      battery: battery(),
      mediaDevices: mediaDevices(),
      geolocationPermission: permissionState('geolocation'),
      webrtc: webrtcIps(budgetMs - 100),
    };
    var keys = Object.keys(probes);
    return Promise.all(keys.map(function (k) { return withTimeout(probes[k], budgetMs); })).then(function (values) {
      keys.forEach(function (k, i) { if (values[i] !== undefined) fp[k] = values[i]; });
      // Stable hash of attributes that survive clearing storage.
      fp.fingerprint = hash(JSON.stringify([
        fp.userAgent, fp.platform, fp.languages, fp.timeZone, fp.screen.width, fp.screen.height,
        fp.screen.colorDepth, fp.screen.pixelRatio, fp.hardwareConcurrency, fp.deviceMemory,
        fp.maxTouchPoints, fp.webgl, fp.canvasHash, fp.uaData && fp.uaData.model,
      ]));
      return fp;
    });
  };
})();
