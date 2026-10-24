/**
 * Poma Pathfinder – wireless.js
 * API: available(), prepare(), scan(), locate(scan), online(),
 *      learn(lat,lon), counts(), exportDb(), importDb(file)
 */
(function () {
  'use strict';

  const BEACONDB_URL  = 'https://api.beacondb.net/v1/geolocate';
  const GOOGLE_URL    = '';
  const BLE_SCAN_MS   = 3500;
  const MIN_WIFI      = 2;
  const MIN_RSSI      = -90;
  const MAX_AGE_MS    = 20000;
  const LOCAL_ACC_THR = 25;
  const FP_K          = 3;
  const FP_MAX_RMS    = 15;

  let plugin    = null;
  let statusMsg = '';
  let db        = null;

  function log(msg) {
    console.log('[PomaWireless ' + new Date().toTimeString().slice(0, 8) + '] ' + msg);
    const el = document.getElementById('wireless-log');
    if (el) el.textContent = msg;
  }

  function openDb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('PomaWireless', 2);
      r.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('fingerprints'))
          d.createObjectStore('fingerprints', { keyPath: 'id', autoIncrement: true });
        if (!d.objectStoreNames.contains('beacons'))
          d.createObjectStore('beacons', { keyPath: 'id' });
      };
      r.onsuccess = e => res(e.target.result);
      r.onerror   = e => rej(e.target.error);
    });
  }
  async function ensureDb() { if (!db) db = await openDb(); return db; }
  async function dbAll(store) {
    await ensureDb();
    return new Promise((res, rej) => {
      const r = db.transaction(store, 'readonly').objectStore(store).getAll();
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function dbPut(store, item) {
    await ensureDb();
    return new Promise((res, rej) => {
      const r = db.transaction(store, 'readwrite').objectStore(store).put(item);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function dbClear(store) {
    await ensureDb();
    return new Promise((res, rej) => {
      const r = db.transaction(store, 'readwrite').objectStore(store).clear();
      r.onsuccess = () => res(); r.onerror = () => rej(r.error);
    });
  }

  function filterWifi(aps) {
    return (aps || []).filter(ap => {
      if (!ap.bssid) return false;
      if ((ap.level ?? ap.rssi ?? -999) < MIN_RSSI) return false;
      if (ap.age != null && ap.age > MAX_AGE_MS) return false;
      if ((parseInt(ap.bssid.split(':')[0], 16) & 0x02) !== 0) return false;
      if ((ap.ssid || '').endsWith('_nomap')) return false;
      return true;
    }).slice(0, 25);
  }
  function filterBle(devs) {
    return (devs || []).filter(d => (d.rssi ?? -999) > -100).slice(0, 15);
  }
  function isMac(s) { return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(s || ''); }
  function buildSignalMap(wifi, ble) {
    const m = {};
    for (const ap of filterWifi(wifi)) m[ap.bssid] = ap.level ?? ap.rssi;
    for (const d of filterBle(ble)) m['ble:' + d.id] = d.rssi;
    return m;
  }
  function toArray(v, ...keys) {
    if (Array.isArray(v)) return v;
    for (const k of keys) if (Array.isArray(v?.[k])) return v[k];
    return [];
  }

  async function fingerprintLocate(wifi, ble) {
    const prints = await dbAll('fingerprints');
    if (prints.length < 3) return null;
    const cur = buildSignalMap(wifi, ble);
    const keys = Object.keys(cur);
    if (!keys.length) return null;
    const scored = prints.map(fp => {
      const shared = keys.filter(k => fp.signals[k] != null);
      if (shared.length < 3) return null;
      const rms = Math.sqrt(shared.reduce((s, k) => {
        const d = cur[k] - fp.signals[k]; return s + d * d;
      }, 0) / shared.length);
      return { fp, rms };
    }).filter(Boolean).sort((a, b) => a.rms - b.rms);
    if (!scored.length || scored[0].rms > FP_MAX_RMS) return null;
    const top = scored.slice(0, FP_K);
    let wLat = 0, wLon = 0, wS = 0;
    top.forEach(({ fp, rms }) => { const w = 1 / (rms + 1); wLat += fp.lat * w; wLon += fp.lon * w; wS += w; });
    const lat = wLat / wS, lon = wLon / wS;
    const spread = top.reduce((mx, { fp }) => Math.max(mx,
      Math.hypot((fp.lat - lat) * 111320, (fp.lon - lon) * 111320 * Math.cos(lat * Math.PI / 180))), 0);
    const acc = Math.min(60, Math.max(4, spread + scored[0].rms / 2));
    log('Sormenjälki: osuma ±' + acc.toFixed(0) + 'm');
    return { lat, lon, acc, src: 'fingerprint' };
  }

  async function beaconLocate(ble) {
    const known = await dbAll('beacons');
    if (!known.length) return null;
    const hits = filterBle(ble).map(d => {
      const b = known.find(k => k.id === d.id);
      if (!b) return null;
      const dist = Math.pow(10, ((b.txPower ?? d.txPower ?? -59) - d.rssi) / 20);
      return dist > 30 ? null : { b, dist };
    }).filter(Boolean);
    if (!hits.length || (hits.length === 1 && hits[0].dist > 8)) return null;
    let wLat = 0, wLon = 0, wS = 0;
    hits.forEach(({ b, dist }) => { const w = 1 / (dist * dist + 0.01); wLat += b.lat * w; wLon += b.lon * w; wS += w; });
    const acc = hits.length === 1 ? hits[0].dist * 1.5 : hits[0].dist;
    return { lat: wLat / wS, lon: wLon / wS, acc: Math.max(3, acc), src: 'ble-beacon' };
  }

  async function onlineLocate(wifi, ble) {
    const aps = filterWifi(wifi);
    if (aps.length < MIN_WIFI) { statusMsg = 'Liian vähän Wi-Fi-tukiasemia (' + aps.length + ')'; log(statusMsg); return null; }
    const wPay = aps.map(ap => ({
      macAddress: ap.bssid,
      signalStrength: ap.level ?? ap.rssi,
      channel: ap.frequency ? Math.round((ap.frequency - 2407) / 5) : undefined,
    }));
    const bPay = filterBle(ble).filter(d => isMac(d.id))
      .map(d => ({ macAddress: d.id, signalStrength: Math.round(d.rssi) }));
    const endpoints = [];
    if (GOOGLE_URL) endpoints.push({ name: 'Google', url: GOOGLE_URL,
      body: { considerIp: false, wifiAccessPoints: wPay, ...(bPay.length ? { bluetoothDevices: bPay } : {}) } });
    endpoints.push({ name: 'BeaconDB', url: BEACONDB_URL,
      body: { considerIp: false, wifiAccessPoints: wPay, ...(bPay.length ? { bluetoothBeacons: bPay } : {}) } });
    for (const ep of endpoints) {
      try {
        log('Online: ' + ep.name + ' (' + wPay.length + ' AP)');
        const res = await fetch(ep.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ep.body),
        });
        if (!res.ok) { statusMsg = ep.name + ': HTTP ' + res.status + (res.status === 404 ? ' (ei dataa tältä alueelta)' : ''); log(statusMsg); continue; }
        const data = await res.json();
        if (data?.location?.lat == null) { statusMsg = ep.name + ': ei koordinaatteja'; log(statusMsg); continue; }
        const result = { lat: data.location.lat, lon: data.location.lng, acc: Math.max(15, data.accuracy ?? 100), src: ep.name };
        statusMsg = ep.name + ': ±' + Math.round(result.acc) + 'm';
        log(statusMsg + ' ' + result.lat.toFixed(5) + ', ' + result.lon.toFixed(5));
        return result;
      } catch (e) { statusMsg = ep.name + ': verkkovirhe ' + e.message; log(statusMsg); }
    }
    return null;
  }

  const W = {
    available() { return plugin !== null; },

    async prepare() {
      if (!plugin) return;
      try {
        if (plugin.requestAllPermissions) await plugin.requestAllPermissions();
        log('Luvat pyydetty');
      } catch (e) { log('prepare-virhe: ' + e.message); }
    },

    async scan() {
      if (!plugin) return { wifi: [], ble: [], errors: ['ei pluginia'], throttled: false };
      const [wRes, bRes] = await Promise.allSettled([
        plugin.scanWifi(),
        plugin.scanBle({ duration: BLE_SCAN_MS }),
      ]);
      const errors = [];
      let wifi = [], ble = [];
      if (wRes.status === 'fulfilled') wifi = toArray(wRes.value, 'accessPoints', 'results', 'aps', 'wifi');
      else errors.push('wifi: ' + (wRes.reason?.message || wRes.reason));
      if (bRes.status === 'fulfilled') ble = toArray(bRes.value, 'devices', 'results', 'ble', 'beacons');
      else errors.push('ble: ' + (bRes.reason?.message || bRes.reason));
      log('Skannaus: ' + wifi.length + ' Wi-Fi, ' + ble.length + ' BLE' + (errors.length ? ' | ' + errors.join('; ') : ''));
      return { wifi, ble, errors, throttled: !!(wRes.value && wRes.value.throttled) };
    },

    async locate(scanResult) {
      const wifi = scanResult?.wifi ?? [];
      const ble  = scanResult?.ble ?? [];
      const [fp, bl] = await Promise.all([fingerprintLocate(wifi, ble), beaconLocate(ble)]);
      const local = (fp && bl) ? (fp.acc <= bl.acc ? fp : bl) : (fp || bl || null);
      if (local && local.acc <= LOCAL_ACC_THR) { statusMsg = local.src + ': ±' + Math.round(local.acc) + 'm'; return local; }
      const online = await onlineLocate(wifi, ble);
      if (!online) return local;
      if (!local) return online;
      return online.acc <= local.acc ? online : local;
    },

    online() { return statusMsg; },

    async learn(lat, lon) {
      if (!plugin || lat == null || lon == null) return;
      const s = await W.scan();
      const signals = buildSignalMap(s.wifi, s.ble);
      if (!Object.keys(signals).length) { alert('Ei signaaleja. Laita Wi-Fi ja Bluetooth päälle.'); return; }
      await dbPut('fingerprints', { lat, lon, signals, ts: Date.now() });
      const all = await dbAll('fingerprints');
      alert('Tallennettu! Sormenjälkiä yhteensä: ' + all.length);
    },

    async counts() {
      const [f, b] = await Promise.all([dbAll('fingerprints'), dbAll('beacons')]);
      return { fingerprints: f.length, beacons: b.length };
    },

    async exportDb() {
      const [f, b] = await Promise.all([dbAll('fingerprints'), dbAll('beacons')]);
      const blob = new Blob([JSON.stringify({ fingerprints: f, beacons: b }, null, 2)], { type: 'application/json' });
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(blob),
        download: 'poma-wireless-' + new Date().toISOString().slice(0, 10) + '.json',
      });
      a.click(); URL.revokeObjectURL(a.href);
    },

    async importDb(file) {
      const data = JSON.parse(await file.text());
      if (data.fingerprints) { await dbClear('fingerprints'); for (const x of data.fingerprints) await dbPut('fingerprints', x); }
      if (data.beacons) { await dbClear('beacons'); for (const x of data.beacons) await dbPut('beacons', x); }
      const c = await W.counts();
      alert('Tuotu: ' + c.fingerprints + ' sormenjälkeä, ' + c.beacons + ' majakkaa');
    },
  };

  // Julkaistaan heti, jotta script.js löytää moduulin
  window.PomaWireless = W;

  // Plugin haetaan heti (synkronisesti)
  try {
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
      plugin = window.Capacitor.registerPlugin('PomaSensors');
      log('PomaSensors-plugin löytyi');
    } else {
      log('Ei natiivialustaa: toimii vain Android-sovelluksessa');
    }
  } catch (e) { log('Plugin-virhe: ' + e.message); }

  // Luvat pyydetään kun sivu on valmis
  function start() { if (plugin) W.prepare(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
