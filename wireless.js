/* Wi-Fi + Bluetooth positioning. Needs the native PomaSensors plugin (Android app).
   In a normal browser available() is false and nothing here runs. */
(() => {
  "use strict";
  const FP_KEY = "poma.fingerprints", BEACON_KEY = "poma.beacons";
  const plugin = () => (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PomaSensors) || null;
  const available = () => !!plugin() && !!(window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const load = k => { try { return JSON.parse(localStorage.getItem(k)) || []; } catch { return []; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
  let fingerprints = load(FP_KEY);
  let beacons = (() => { try { return JSON.parse(localStorage.getItem(BEACON_KEY)) || {}; } catch { return {}; } })();

  const usableWifi = w => w.bssid && w.rssi > -90 && w.ageMs < 20000 &&
    !(parseInt(w.bssid.slice(0, 2), 16) & 2) &&               // skip locally administered (phone hotspots)
    !/_nomap$/i.test(w.ssid || "");                            // respect opt-out
  const toMap = (list, key) => Object.fromEntries(list.map(x => [x[key], x.rssi]));

  async function prepare() {
    const p = plugin();
    let s = await p.getStatus();
    if (!s.wifiPermission || !s.blePermission) s = await p.requestAllPermissions();
    return s;
  }

  async function scan(durationMs = 4000) {
    const p = plugin();
    const [w, b] = await Promise.allSettled([p.scanWifi(), p.scanBle({ durationMs })]);
    return {
      wifi: w.status === "fulfilled" ? w.value.results.filter(usableWifi) : [],
      ble: b.status === "fulfilled" ? b.value.results.filter(x => x.rssi > -100) : [],
      throttled: w.status === "fulfilled" && w.value.throttled,
      errors: [w, b].filter(r => r.status === "rejected").map(r => String(r.reason && (r.reason.message || r.reason)))
    };
  }

  /* --- 1. Fingerprint matching against places the user has surveyed (best: 3-8 m) --- */
  function fpDistance(cur, fp) {
    let sum = 0, n = 0, shared = 0;
    for (const k of new Set([...Object.keys(cur), ...Object.keys(fp)])) {
      const a = cur[k] ?? -100, b = fp[k] ?? -100;
      if (cur[k] !== undefined && fp[k] !== undefined) shared++;
      sum += (a - b) ** 2; n++;
    }
    return { d: n ? Math.sqrt(sum / n) : Infinity, shared };
  }
  function locateFingerprint(sc) {
    if (fingerprints.length < 3) return null;
    const cur = { ...toMap(sc.wifi, "bssid"), ...Object.fromEntries(sc.ble.map(x => ["ble:" + x.id, x.rssi])) };
    const scored = fingerprints
      .map(f => ({ f, ...fpDistance(cur, f.s) })).filter(x => x.shared >= 3)
      .sort((a, b) => a.d - b.d).slice(0, 3);
    if (!scored.length || scored[0].d > 15) return null;       // unfamiliar place
    let wsum = 0, lat = 0, lon = 0;
    for (const x of scored) { const w = 1 / (x.d + 1); wsum += w; lat += w * x.f.lat; lon += w * x.f.lon; }
    lat /= wsum; lon /= wsum;
    const spread = Math.max(...scored.map(x => Math.hypot((x.f.lat - lat) * 111320, (x.f.lon - lon) * 111320 * Math.cos(lat * Math.PI / 180))));
    return { lat, lon, acc: Math.min(60, Math.max(4, spread + scored[0].d * 0.5)), src: "Wi-Fi/BLE fingerprint" };
  }

  /* --- 2. Known BLE beacons (imported list with coordinates) --- */
  function locateBeacons(sc) {
    const known = sc.ble.filter(b => beacons[b.id]);
    if (!known.length) return null;
    const est = known.map(b => {
      const bc = beacons[b.id], tx = bc.tx ?? b.tx ?? -59;
      return { lat: bc.lat, lon: bc.lon, d: Math.max(0.5, Math.pow(10, (tx - b.rssi) / 22)) };
    });
    if (est.length === 1) return est[0].d < 8 ? { lat: est[0].lat, lon: est[0].lon, acc: Math.max(4, est[0].d * 1.5), src: "BLE beacon" } : null;
    let wsum = 0, lat = 0, lon = 0;
    for (const e of est) { const w = 1 / (e.d * e.d); wsum += w; lat += w * e.lat; lon += w * e.lon; }
    return { lat: lat / wsum, lon: lon / wsum, acc: Math.max(4, Math.min(...est.map(e => e.d)) * 1.5), src: "BLE beacons" };
  }

  /* --- 3. Online database (BeaconDB, Mozilla Location Service format). Needs internet and
         crowd-sourced coverage; typical accuracy tens to hundreds of metres. --- */
  async function locateOnline(sc) {
    if (sc.wifi.length < 2 || navigator.onLine === false) return null;
    const body = { considerIp: false, wifiAccessPoints: sc.wifi.slice(0, 25).map(w => ({ macAddress: w.bssid, signalStrength: w.rssi, frequency: w.freq })) };
    if (sc.ble.length) body.bluetoothBeacons = sc.ble.slice(0, 15).filter(b => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(b.id)).map(b => ({ macAddress: b.id, signalStrength: b.rssi }));
    try {
      const r = await fetch("https://api.beacondb.net/v1/geolocate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) return null;
      const j = await r.json();
      return j && j.location ? { lat: j.location.lat, lon: j.location.lng, acc: Math.max(15, j.accuracy || 100), src: "Wi-Fi database (BeaconDB)" } : null;
    } catch { return null; }
  }

  async function locate(sc) {
    const local = locateFingerprint(sc) || locateBeacons(sc);
    if (local && local.acc <= 25) return local;
    const online = await locateOnline(sc);
    return [local, online].filter(Boolean).sort((a, b) => a.acc - b.acc)[0] || null;
  }

  function learn(lat, lon, sc) {
    const s = { ...toMap(sc.wifi, "bssid"), ...Object.fromEntries(sc.ble.map(x => ["ble:" + x.id, x.rssi])) };
    if (Object.keys(s).length < 3) return false;
    fingerprints.push({ lat, lon, t: Date.now(), s });
    save(FP_KEY, fingerprints);
    return true;
  }
  const exportDb = () => ({ fingerprints, beacons });
  function importDb(obj) {
    if (Array.isArray(obj.fingerprints)) { fingerprints = fingerprints.concat(obj.fingerprints); save(FP_KEY, fingerprints); }
    if (obj.beacons && typeof obj.beacons === "object") { beacons = { ...beacons, ...obj.beacons }; try { localStorage.setItem(BEACON_KEY, JSON.stringify(beacons)); } catch { /* ignore */ } }
  }

  window.PomaWireless = { available, prepare, scan, locate, learn, exportDb, importDb,
    counts: () => ({ fingerprints: fingerprints.length, beacons: Object.keys(beacons).length }) };
})();
