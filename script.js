/**
 * Poma Pathfinder – wireless.js  (korjattu versio)
 *
 * Rajapinta (sama kuin script.js odottaa):
 *   PomaWireless.available()        → bool
 *   PomaWireless.prepare()          → Promise  (pyytää luvat)
 *   PomaWireless.scan()             → Promise<scanResult>
 *   PomaWireless.locate(scanResult) → Promise<{lat,lon,acc,src}|null>
 *   PomaWireless.online()           → string (viimeisin tilaviesti)
 *   PomaWireless.learn(lat, lon)    → Promise (tallenna sormenjälki)
 *   PomaWireless.counts()           → Promise<{fingerprints,beacons}>
 *   PomaWireless.exportDb()         → Promise
 *   PomaWireless.importDb(file)     → Promise
 */

(function () {
  'use strict';

  const BEACONDB_URL  = 'https://beacondb.net/v1/geolocate';
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

  function dbAll(store) {
    return new Promise((res, rej) => {
      const r = db.transaction(store, 'readonly').objectStore(store).getAll();
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });
  }

  function dbPut(store, item) {
    return new Promise((res, rej) => {
      const r = db.transaction(store, 'readwrite').objectStore(store).put(item);
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });
  }

  function dbClear(store) {
    return new Promise((res, rej) => {
      const r = db.transaction(store, 'readwrite').objectStore(store).clear();
      r.onsuccess = () => res();
      r.onerror   = () => rej(r.error);
    });
  }

  function filterWifi(aps) {
    return (aps || []).filter(ap => {
      if (!ap.bssid) return false;
      if ((ap.level ?? ap.rssi ?? -999) < MIN_RSSI) return false;
      if (ap.age != null && ap.age > MAX_AGE_MS) return false;
      if ((parseInt((ap.bssid).split(':')[0], 16) & 0x02) !== 0) return false;
      if ((ap.ssid || '').endsWith('_nomap')) return false;
      return true;
    }).slice(0, 25);
  }

  function filterBle(devs) {
    return (devs || []).filter(d => (d.rssi ?? -999) > -100).slice(0, 15);
  }

  function isMac(s) {
    return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(s);
  }

  function buildSignalMap(wifi, ble) {
    const m = {};
    for (const ap of filterWifi(wifi)) m[ap.bssid]       = ap.level ?? ap.rssi;
    for (const d  of filterBle(ble))  m['ble:' + d.id]  = d.rssi;
    return m;
  }

  function log(msg) {
    console.log('[PomaWireless ' + new Date().toTimeString().slice(0,8) + '] ' + msg);
    const el = document.getElementById('wireless-log');
    if (el) el.textContent = msg;
  }

  async function fingerprintLocate(wifi, ble) {
    const prints = await dbAll('fingerprints');
    if (prints.length < 3) return null;
    const cur  = buildSignalMap(wifi, ble);
    const keys = Object.keys(cur);
    if (keys.length === 0) return null;
    const scored = prints.map(fp => {
      const shared = keys.filter(k => fp.signals[k] != null);
      if (shared.length < 3) return null;
      const rms = Math.sqrt(shared.reduce((s, k) => {
        const d = (cur[k] ?? -100) - (fp.signals[k] ?? -100);
        return s + d * d;
      }, 0) / shared.length);
      return { fp, rms };
    }).filter(Boolean).sort((a, b) => a.rms - b.rms);
    if (!scored.length || scored[0].rms > FP_MAX_RMS) return null;
    const top = scored.slice(0, FP_K);
    let wLat = 0, wLon = 0, wS = 0;
    top.forEach(({ fp, rms }) => { const w = 1/(rms+1); wLat+=fp.lat*w; wLon+=fp.lon*w; wS+=w; });
    const lat = wLat/wS, lon = wLon/wS;
    const spread = top.reduce((mx, {fp}) =>
      Math.max(mx, Math.hypot((fp.lat-lat)*111320, (fp.lon-lon)*111320*Math.cos(lat*Math.PI/180))), 0);
    const acc = Math.min(60, Math.max(4, spread + scored[0].rms/2));
    log('Sormenjälki: osuma → ±' + acc.toFixed(0) + 'm');
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
    let wLat=0,wLon=0,wS=0;
    hits.forEach(({b,dist}) => { const w=1/(dist*dist+.01); wLat+=b.lat*w; wLon+=b.lon*w; wS+=w; });
    const acc = hits.length === 1 ? hits[0].dist*1.5 : hits[0].dist;
    return { lat:wLat/wS, lon:wLon/wS, acc:Math.max(3,acc), src:'ble-beacon' };
  }

  async function onlineLocate(wifi, ble) {
    const aps = filterWifi(wifi);
    if (aps.length < MIN_WIFI) { log('Online: liian vähän AP:ja (' + aps.length + ')'); return null; }
    const wPay = aps.map(ap => ({
      macAddress:     ap.bssid,
      signalStrength: ap.level ?? ap.rssi,
      channel:        ap.frequency ? Math.round((ap.frequency-2407)/5) : undefined,
    }));
    const bPay = filterBle(ble).filter(d=>isMac(d.id))
      .map(d => ({ macAddress:d.id, signalStrength:Math.round(d.rssi) }));
    const endpoints = [];
    if (GOOGLE_URL) {
      endpoints.push({ name:'Google', url:GOOGLE_URL,
        body:{ considerIp:false, wifiAccessPoints:wPay, ...(bPay.length?{bluetoothDevices:bPay}:{}) }});
    }
    endpoints.push({ name:'BeaconDB', url:BEACONDB_URL,
      body:{ considerIp:false, wifiAccessPoints:wPay, ...(bPay.length?{bluetoothBeacons:bPay}:{}) }});
    for (const ep of endpoints) {
      try {
        log('Online: ' + ep.name + ' (' + wPay.length + ' AP)...');
        const res = await fetch(ep.url, {
          method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(ep.body),
        });
        if (!res.ok) { log(ep.name + ': HTTP ' + res.status); continue; }
        const data = await res.json();
        if (data?.location?.lat == null) { log(ep.name + ': ei koordinaatteja'); continue; }
        const result = { lat:data.location.lat, lon:data.location.lng,
          acc:Math.max(15, data.accuracy??100), src:ep.name };
        statusMsg = ep.name + ': ±' + Math.round(result.acc) + 'm';
        log(ep.name + ': ✅ ' + result.lat.toFixed(5) + ', ' + result.lon.toFixed(5) + ' ±' + Math.round(result.acc) + 'm');
        return result;
      } catch(e) { log(ep.name + ': ' + e.message); }
    }
    statusMsg = 'Online-paikannus epäonnistui';
    return null;
  }

  const W = {
    available() { return plugin !== null; },

    async prepare() {
      if (!plugin) return;
      try {
        const status = await plugin.getStatus();
        log('Status: ' + JSON.stringify(status));
        if (!status.wifiPermission || !status.blePermission) {
          await plugin.requestAllPermissions();
          log('Luvat pyydetty');
        }
      } catch(e) { log('prepare virhe: ' + e.message); }
    },

    async scan() {
      if (!plugin) return { wifi:[], ble:[], errors:[], throttled:false };
      try {
        log('Skannataan...');
        const [wRes, bRes] = await Promise.allSettled([
          plugin.scanWifi(),
          plugin.scanBle({ duration: BLE_SCAN_MS }),
        ]);
        const wifi   = wRes.status==='fulfilled' ? (wRes.value?.accessPoints ?? wRes.value?.results ?? wRes.value ?? []) : [];
        const ble    = bRes.status==='fulfilled' ? (bRes.value?.devices ?? bRes.value?.results ?? bRes.value ?? []) : [];
        const errors = [];
        if (wRes.status==='rejected') { errors.push('wifi: '+wRes.reason); log('Wi-Fi virhe: '+wRes.reason); }
        if (bRes.status==='rejected') { errors.push('ble: '+bRes.reason);  log('BLE virhe: '+bRes.reason); }
        log('Skannaus: ' + wifi.length + ' AP, ' + ble.length + ' BLE');
        return { wifi, ble, errors, throttled: wRes.value?.throttled ?? false };
      } catch(e) {
        log('scan virhe: ' + e.message);
        return { wifi:[], ble:[], errors:[e.message], throttled:false };
      }
    },

    async locate(scanResult) {
      const wifi = scanResult?.wifi ?? [];
      const ble  = scanResult?.ble  ?? [];
      const [fp, bl] = await Promise.all([fingerprintLocate(wifi,ble), beaconLocate(ble)]);
      let local = (fp&&bl)?(fp.acc<=bl.acc?fp:bl):(fp??bl??null);
      if (local && local.acc <= LOCAL_ACC_THR) { statusMsg=local.src+': ±'+Math.round(local.acc)+'m'; return local; }
      const online = await onlineLocate(wifi, ble);
      if (!online&&!local) return null;
      if (!online) return local;
      if (!local)  return online;
      return online.acc<=local.acc?online:local;
    },

    online() { return statusMsg; },

    async learn(lat, lon) {
      if (!plugin||!lat||!lon) return;
      const s = await W.scan();
      const signals = buildSignalMap(s.wifi, s.ble);
      if (!Object.keys(signals).length) { alert('Ei signaaleja'); return; }
      await dbPut('fingerprints', { lat, lon, signals, ts:Date.now() });
      const all = await dbAll('fingerprints');
      log('Sormenjälki #' + all.length + ' tallennettu');
      alert('Tallennettu! Yhteensä: ' + all.length);
    },

    async counts() {
      const [fps,beacons] = await Promise.all([dbAll('fingerprints'),dbAll('beacons')]);
      return { fingerprints:fps.length, beacons:beacons.length };
    },

    async exportDb() {
      const [fps,beacons] = await Promise.all([dbAll('fingerprints'),dbAll('beacons')]);
      const blob = new Blob([JSON.stringify({fingerprints:fps,beacons},null,2)],{type:'application/json'});
      const a = Object.assign(document.createElement('a'),{href:URL.createObjectURL(blob),download:'poma-wireless-'+new Date().toISOString().slice(0,10)+'.json'});
      a.click(); URL.revokeObjectURL(a.href);
    },

    async importDb(file) {
      const data = JSON.parse(await file.text());
      if (data.fingerprints) { await dbClear('fingerprints'); for (const fp of data.fingerprints) await dbPut('fingerprints',fp); }
      if (data.beacons)      { await dbClear('beacons');      for (const b  of data.beacons)      await dbPut('beacons',b); }
      const c = await W.counts();
      alert('Tuotu: '+c.fingerprints+' sormenjälkeä, '+c.beacons+' majakka');
    },
  };

  async function init() {
    try { db = await openDb(); } catch(e) { log('IndexedDB virhe: '+e.message); }
    try {
      if (window.Capacitor && window.Capacitor.isNativePlatform()) {
        const { PomaSensors } = window.Capacitor.Plugins;
        if (PomaSensors) {
          plugin = PomaSensors;
          log('PomaSensors löytyi ✅');
          await W.prepare();
        } else {
          log('PomaSensors PUUTTUU – tarkista MainActivity.java');
        }
      } else {
        log('Ei natiivialustaa – toimii vain Android-sovelluksessa');
      }
    } catch(e) { log('Alustusvirhe: '+e.message); }
    const c = await W.counts();
    log('Valmis – '+c.fingerprints+' sormenjälkeä, '+c.beacons+' majakka');
    window.PomaWireless = W;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
