/* Poma Pathfinder – positioning engine (no GPS anywhere).
 *
 * Absolute position comes from radio observations:
 *   1. places the user has taught the app (fingerprints: Wi-Fi + BLE + mobile cells)
 *   2. the BeaconDB database (Wi-Fi access points + mobile cell towers), needs internet
 * Between fixes the position is carried forward by pedestrian dead reckoning (steps + compass).
 *
 * Needs the native PomaSensors plugin for radio scans (Android app). Everything else is plain JS.
 */
(function (root) {
  "use strict";

  const API_URL = "https://api.beacondb.net/v1/geolocate";
  const FP_KEY = "poma.fingerprints.v2";
  const FP_MAX = 3000;
  const RAD = Math.PI / 180;

  /* ------------------------------------------------------------------ geometry */

  const M_PER_DEG = 111320;
  function moveBy(lat, lon, east, north) {
    return { lat: lat + north / M_PER_DEG, lon: lon + east / (M_PER_DEG * Math.cos(lat * RAD)) };
  }
  function distM(a, b) {
    const dn = (b.lat - a.lat) * M_PER_DEG;
    const de = (b.lon - a.lon) * M_PER_DEG * Math.cos(((a.lat + b.lat) / 2) * RAD);
    return Math.hypot(dn, de);
  }
  const norm360 = d => ((d % 360) + 360) % 360;
  function circMean(angles, weights) {
    let s = 0, c = 0;
    angles.forEach((a, i) => { const w = weights ? weights[i] : 1; s += w * Math.sin(a * RAD); c += w * Math.cos(a * RAD); });
    return norm360(Math.atan2(s, c) / RAD);
  }

  /* Compass heading (degrees clockwise from magnetic north) from W3C alpha/beta/gamma.
     Uses the horizontal part of both the phone's top edge and its rear-camera axis, so it
     works whether the phone is held flat or upright. Returns null if the phone is ambiguous. */
  function headingFromEuler(alpha, beta, gamma) {
    const a = alpha * RAD, b = beta * RAD, g = gamma * RAD;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
    // R = Rz(a) * Rx(b) * Ry(g); columns are the device axes in the East-North-Up frame
    const R = [
      [ca * cg - sa * sb * sg, -sa * cb, ca * sg + sa * sb * cg],
      [sa * cg + ca * sb * sg,  ca * cb, sa * sg - ca * sb * cg],
      [-cb * sg,                sb,      cb * cg]
    ];
    const topE = R[0][1], topN = R[1][1];          // device y axis (top edge)
    const rearE = -R[0][2], rearN = -R[1][2];      // minus device z axis (rear camera)
    const e = topE + rearE, n = topN + rearN;
    if (Math.hypot(e, n) < 0.15) return null;
    return norm360(Math.atan2(e, n) / RAD);
  }

  /* ------------------------------------------------------------------ step detector */

  function createStepDetector() {
    let g = 9.81, smooth = 0, armed = true, lastStep = 0, peak = 1.2;
    return {
      /* feed accelerometer incl. gravity (m/s^2) with time in ms; returns true when a step is taken */
      feed(t, ax, ay, az) {
        const mag = Math.sqrt(ax * ax + ay * ay + az * az);
        g += 0.02 * (mag - g);
        smooth = 0.7 * smooth + 0.3 * (mag - g);
        peak = Math.max(0.6, peak * 0.999);
        const thr = Math.max(0.7, peak * 0.4);
        if (armed && smooth > thr && t - lastStep > 300) {
          armed = false; lastStep = t; peak = Math.max(peak, smooth * 1.4);
          return true;
        }
        if (!armed && smooth < thr * 0.3) armed = true;
        return false;
      }
    };
  }

  /* ------------------------------------------------------------------ position tracker */

  function createTracker() {
    const s = { has: false, lat: 0, lon: 0, sigma: 1e6, src: "", steps: 0, meters: 0 };
    return {
      state: s,
      setPosition(lat, lon, sigma, src) { s.has = true; s.lat = lat; s.lon = lon; s.sigma = sigma; s.src = src; },
      /* one step of `len` metres towards compass heading `deg` */
      step(deg, len) {
        s.steps++;
        if (!s.has || deg == null) return false;
        const p = moveBy(s.lat, s.lon, len * Math.sin(deg * RAD), len * Math.cos(deg * RAD));
        s.lat = p.lat; s.lon = p.lon; s.meters += len;
        s.sigma = Math.hypot(s.sigma, 0.09 * len * 6) ; // drift: ~0.5 m error per step (heading + length)
        return true;
      },
      /* blend an absolute fix {lat,lon,acc,src}; variance-weighted, so precise fixes pull harder */
      fuse(fix) {
        if (!s.has) { this.setPosition(fix.lat, fix.lon, fix.acc, fix.src); return "set"; }
        const v = s.sigma * s.sigma, a = fix.acc * fix.acc, K = v / (v + a);
        s.lat += K * (fix.lat - s.lat); s.lon += K * (fix.lon - s.lon);
        s.sigma = Math.sqrt((1 - K) * v);
        s.src = fix.src;
        return K;
      }
    };
  }

  /* ------------------------------------------------------------------ radio scanning */

  let plugin;
  let lastMessage = "";
  let lastStatus = null;

  function getPlugin() {
    if (plugin !== undefined) return plugin;
    plugin = null;
    try {
      const C = root.Capacitor;
      if (C && C.isNativePlatform && C.isNativePlatform()) {
        plugin = (C.Plugins && C.Plugins.PomaSensors) || (C.registerPlugin && C.registerPlugin("PomaSensors")) || null;
      }
    } catch (e) { plugin = null; }
    return plugin;
  }
  const available = () => !!getPlugin();

  const withTimeout = (p, ms, label) => Promise.race([
    p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + " timeout")), ms))]);
  const errText = r => String((r && (r.message || r.errorMessage || r.code)) || r);

  async function status() {
    const p = getPlugin();
    if (!p) return null;
    lastStatus = await withTimeout(p.getStatus(), 5000, "status");
    return lastStatus;
  }
  async function prepare() {
    const p = getPlugin();
    if (!p) return null;
    let st = await status();
    if (!st.locationPermission || !st.blePermission) st = lastStatus = await withTimeout(p.requestAllPermissions(), 60000, "permissions");
    return st;
  }

  const usableWifi = w => w && w.bssid && w.rssi > -90 && w.ageMs < 120000 &&
    !(parseInt(w.bssid.slice(0, 2), 16) & 2) &&        // locally administered = phone hotspots / randomised
    !/_nomap$/i.test(w.ssid || "");                    // respect opt-out
  const usableCell = c => c && ["lte", "gsm", "wcdma"].includes(c.type) && c.mcc >= 0 && c.mnc >= 0 && c.area > 0 && c.cid > 0 &&
    !(c.cid === 2147483647);

  /* Runs all scans in parallel. Never throws; problems are listed in .errors */
  async function scan() {
    const p = getPlugin();
    const out = { t: Date.now(), wifi: [], ble: [], cells: [], errors: [], throttled: false, cellsFresh: false };
    if (!p) { out.errors.push("ei natiivipluginia"); return out; }
    const [w, b, c] = await Promise.allSettled([
      withTimeout(p.scanWifi(), 14000, "wifi"),
      withTimeout(p.scanBle({ durationMs: 3000 }), 8000, "ble"),
      withTimeout(p.scanCells(), 8000, "cells")]);
    if (w.status === "fulfilled") { out.wifi = (w.value.results || []).filter(usableWifi); out.throttled = !!w.value.throttled; out.wifiRaw = (w.value.results || []).length; }
    else out.errors.push("wifi: " + errText(w.reason));
    if (b.status === "fulfilled") out.ble = (b.value.results || []).filter(x => x.rssi > -100);
    else out.errors.push("ble: " + errText(b.reason));
    if (c.status === "fulfilled") { out.cells = c.value.results || []; out.cellsFresh = !!c.value.fresh; }
    else out.errors.push("cells: " + errText(c.reason));
    return out;
  }

  /* ------------------------------------------------------------------ fingerprints (taught places) */

  const cellKey = c => "cell:" + [c.mcc, c.mnc, c.area, c.cid].join("-");
  function signalMap(sc) {
    const m = {};
    sc.wifi.forEach(w => { m[w.bssid] = w.rssi; });
    sc.ble.forEach(x => { m["ble:" + x.id] = x.rssi; });
    sc.cells.filter(c => c.cid && c.rssi != null).forEach(c => { m[cellKey(c)] = c.rssi; });
    return m;
  }
  let fingerprints = (() => { try { return JSON.parse(localStorage.getItem(FP_KEY)) || []; } catch (e) { return []; } })();
  const saveFp = () => { try { localStorage.setItem(FP_KEY, JSON.stringify(fingerprints)); return true; } catch (e) { return false; } };

  function learn(lat, lon, sc) {
    const s = signalMap(sc);
    if (Object.keys(s).length < 3) return false;
    fingerprints.push({ lat, lon, t: Date.now(), s });
    if (fingerprints.length > FP_MAX) fingerprints = fingerprints.slice(-FP_MAX);
    return saveFp();
  }
  function rmsDistance(cur, fp) {
    let sum = 0, n = 0, shared = 0;
    for (const k of new Set([...Object.keys(cur), ...Object.keys(fp)])) {
      if (cur[k] !== undefined && fp[k] !== undefined) shared++;
      sum += ((cur[k] ?? -110) - (fp[k] ?? -110)) ** 2; n++;
    }
    return { d: n ? Math.sqrt(sum / n) : Infinity, shared };
  }
  function locateFingerprint(sc) {
    if (fingerprints.length < 3) return null;
    const cur = signalMap(sc);
    const best = fingerprints.map(f => ({ f, ...rmsDistance(cur, f.s) })).filter(x => x.shared >= 3)
      .sort((a, b) => a.d - b.d).slice(0, 3);
    if (!best.length || best[0].d > 12) return null;                  // unfamiliar place
    let ws = 0, lat = 0, lon = 0;
    best.forEach(x => { const w = 1 / (x.d + 1); ws += w; lat += w * x.f.lat; lon += w * x.f.lon; });
    lat /= ws; lon /= ws;
    const spread = Math.max(...best.map(x => distM({ lat, lon }, x.f)));
    return { lat, lon, acc: Math.min(60, Math.max(5, spread + best[0].d * 0.5)), src: "opittu paikka" };
  }

  /* ------------------------------------------------------------------ online database (BeaconDB) */

  const RADIO = { lte: "lte", gsm: "gsm", wcdma: "wcdma" };
  function buildRequest(sc) {
    const body = { considerIp: false };
    const wifi = sc.wifi.slice().sort((a, b) => b.rssi - a.rssi).slice(0, 25);
    if (wifi.length >= 2) body.wifiAccessPoints = wifi.map(w => ({ macAddress: w.bssid, signalStrength: w.rssi, frequency: w.freq }));
    const seen = new Set();
    const cells = sc.cells.filter(usableCell).sort((a, b) => (b.registered ? 1 : 0) - (a.registered ? 1 : 0))
      .filter(c => { const k = cellKey(c); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6);
    if (cells.length) body.cellTowers = cells.map(c => {
      const o = { radioType: RADIO[c.type], mobileCountryCode: c.mcc, mobileNetworkCode: c.mnc, locationAreaCode: c.area, cellId: c.cid };
      if (c.rssi != null) o.signalStrength = c.rssi;
      if (c.type === "wcdma" && c.pci != null) o.psc = c.pci;
      return o;
    });
    const macs = sc.ble.filter(b => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(b.id)).slice(0, 15);
    if (macs.length) body.bluetoothBeacons = macs.map(b => ({ macAddress: b.id, signalStrength: b.rssi }));
    return { body, wifi: body.wifiAccessPoints ? body.wifiAccessPoints.length : 0, cells: cells.length };
  }

  async function locateOnline(sc) {
    const req = buildRequest(sc);
    const what = `${req.wifi} Wi-Fi, ${req.cells} solua`;
    if (!req.wifi && !req.cells) { lastMessage = "Ei tarpeeksi dataa hakuun (" + what + ")"; return null; }
    try {
      const r = await withTimeout(fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "PomaPathfinder/2.0" },
        body: JSON.stringify(req.body)
      }), 12000, "haku");
      if (r.status === 404) { lastMessage = `BeaconDB: ei tietoa tältä alueelta (${what})`; return null; }
      if (!r.ok) { lastMessage = `BeaconDB: HTTP ${r.status} (${what})`; return null; }
      const j = typeof r.json === "function" ? await r.json() : r.data;
      if (!j || !j.location) { lastMessage = "BeaconDB: tyhjä vastaus"; return null; }
      lastMessage = `BeaconDB: ok (${what})`;
      const src = req.wifi >= 2 ? (req.cells ? "Wi-Fi + mobiiliasemat" : "Wi-Fi-tietokanta") : "mobiiliasema";
      return { lat: j.location.lat, lon: j.location.lng, acc: Math.max(15, j.accuracy || 1000), src };
    } catch (e) {
      lastMessage = "BeaconDB ei vastaa: " + errText(e);
      return null;
    }
  }

  async function locate(sc) {
    const local = locateFingerprint(sc);
    if (local && local.acc <= 25) { lastMessage = "Tunnistettu opittu paikka"; return local; }
    const online = await locateOnline(sc);
    return [local, online].filter(Boolean).sort((a, b) => a.acc - b.acc)[0] || null;
  }

  /* ------------------------------------------------------------------ public API */

  root.PomaEngine = {
    available, status, prepare, scan, locate, learn,
    counts: () => ({ fingerprints: fingerprints.length }),
    message: () => lastMessage,
    lastStatus: () => lastStatus,
    clearFingerprints() { fingerprints = []; saveFp(); },
    // pure helpers (also used by tests)
    moveBy, distM, circMean, norm360, headingFromEuler, createStepDetector, createTracker,
    buildRequest, signalMap, locateFingerprint
  };
})(typeof window !== "undefined" ? window : globalThis);
