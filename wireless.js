/**
 * Poma Pathfinder – wireless.js
 * Wi-Fi + BLE -paikannus ilman GPS:ää
 *
 * Menetelmät järjestyksessä:
 *  1. Paikallinen sormenjälkivertailu  (offline, vaatii etukäteiskartoituksen)
 *  2. BLE-majakkatriangulaatio         (offline, vaatii majakkainfran)
 *  3. BeaconDB geolocation API         (online, ei vaadi API-avainta)
 *
 * Google Geolocation API (parempi kattavuus) – lisää avain jos saat sen:
 */
const GOOGLE_API_KEY = '';   // jätä tyhjäksi jos ei ole

const CFG = {
  beacondbUrl:    'https://beacondb.net/v1/geolocate',
  googleUrl:      `https://www.googleapis.com/geolocation/v1/geolocate?key=${GOOGLE_API_KEY}`,
  scanInterval:   30000,
  bleScanMs:      3500,
  minWifi:        2,
  minRssi:        -90,
  maxAgeMs:       20000,
  fingerprintK:   3,
  fingerprintMax: 15,
  beaconMaxDist:  30,
  localAccThr:    25,
  dbName:         'PomaWireless',
  dbVersion:      2,
};

let plugin    = null;
let lastWifi  = [];
let lastBle   = [];
let statusMsg = 'Ei vielä skannattu';
let db        = null;

async function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CFG.dbName, CFG.dbVersion);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('fingerprints'))
        d.createObjectStore('fingerprints', { keyPath: 'id', autoIncrement: true });
      if (!d.objectStoreNames.contains('beacons'))
        d.createObjectStore('beacons', { keyPath: 'id' });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function dbGetAll(store) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function dbPut(store, item) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(item);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function dbClear(store) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).clear();
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

async function scan() {
  if (!plugin) return;
  try {
    const [wRes, bRes] = await Promise.allSettled([
      plugin.scanWifi(),
      plugin.scanBle({ duration: CFG.bleScanMs }),
    ]);
    if (wRes.status === 'fulfilled') {
      const raw = wRes.value?.accessPoints ?? wRes.value?.results ?? wRes.value ?? [];
      lastWifi = Array.isArray(raw) ? raw : [];
      log(`Wi-Fi: ${lastWifi.length} AP löytyi`);
    } else {
      log(`Wi-Fi-skannaus epäonnistui: ${wRes.reason}`);
    }
    if (bRes.status === 'fulfilled') {
      const raw = bRes.value?.devices ?? bRes.value?.results ?? bRes.value ?? [];
      lastBle = Array.isArray(raw) ? raw : [];
      log(`BLE: ${lastBle.length} laitetta löytyi`);
    } else {
      log(`BLE-skannaus epäonnistui: ${bRes.reason}`);
    }
  } catch (err) {
    log(`Skannausvirhe: ${err.message}`);
  }
}

function filterWifi(aps) {
  return (aps ?? []).filter(ap => {
    if (!ap.bssid) return false;
    const rssi = ap.level ?? ap.rssi ?? -999;
    if (rssi < CFG.minRssi) return false;
    if (ap.age != null && ap.age > CFG.maxAgeMs) return false;
    const first = parseInt((ap.bssid || '').split(':')[0], 16);
    if ((first & 0x02) !== 0) return false;
    if ((ap.ssid ?? '').endsWith('_nomap')) return false;
    return true;
  }).slice(0, 25);
}

function filterBle(devices) {
  return (devices ?? []).filter(d => (d.rssi ?? -999) > -100).slice(0, 15);
}

function macValid(s) {
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(s);
}

function buildSignalMap(wifi, ble) {
  const map = {};
  for (const ap of filterWifi(wifi)) map[ap.bssid]      = ap.level ?? ap.rssi;
  for (const d  of filterBle(ble))  map[`ble:${d.id}`] = d.rssi;
  return map;
}

async function fingerprintLocate(wifi, ble) {
  const prints = await dbGetAll('fingerprints');
  if (prints.length < 3) { log('Sormenjälkejä alle 3'); return null; }
  const current = buildSignalMap(wifi, ble);
  const currentKeys = Object.keys(current);
  if (currentKeys.length === 0) return null;
  const scored = prints.map(fp => {
    const shared = currentKeys.filter(k => fp.signals[k] != null);
    if (shared.length < 3) return null;
    const rms = Math.sqrt(shared.reduce((s, k) => {
      const diff = (current[k] ?? -100) - (fp.signals[k] ?? -100);
      return s + diff * diff;
    }, 0) / shared.length);
    return { fp, rms };
  }).filter(Boolean).sort((a, b) => a.rms - b.rms);
  if (scored.length === 0) return null;
  if (scored[0].rms > CFG.fingerprintMax) { log(`Sormenjälki: paikka tuntematon (RMS ${scored[0].rms.toFixed(1)})`); return null; }
  const top = scored.slice(0, CFG.fingerprintK);
  let wLat = 0, wLon = 0, wSum = 0;
  for (const { fp, rms } of top) { const w = 1/(rms+1); wLat+=fp.lat*w; wLon+=fp.lon*w; wSum+=w; }
  const lat = wLat/wSum, lon = wLon/wSum;
  const spread = top.reduce((max, {fp}) => Math.max(max, Math.hypot((fp.lat-lat)*111320, (fp.lon-lon)*111320*Math.cos(lat*Math.PI/180))), 0);
  const acc = Math.min(60, Math.max(4, spread + scored[0].rms/2));
  log(`Sormenjälki: osuma → ±${acc.toFixed(0)}m`);
  return { lat, lon, acc, src: 'fingerprint' };
}

async function beaconLocate(ble) {
  const known = await dbGetAll('beacons');
  if (known.length === 0) return null;
  const hits = filterBle(ble).map(device => {
    const beacon = known.find(b => b.id === device.id);
    if (!beacon) return null;
    const txPower = beacon.txPower ?? device.txPower ?? -59;
    const dist = Math.pow(10, (txPower - device.rssi) / 20);
    return dist > CFG.beaconMaxDist ? null : { beacon, dist };
  }).filter(Boolean);
  if (hits.length === 0) return null;
  if (hits.length === 1 && hits[0].dist > 8) return null;
  let wLat=0,wLon=0,wSum=0;
  for (const {beacon,dist} of hits) { const w=1/(dist*dist+0.01); wLat+=beacon.lat*w; wLon+=beacon.lon*w; wSum+=w; }
  const acc = hits.length===1 ? hits[0].dist*1.5 : hits[0].dist;
  log(`BLE-majakat: ${hits.length} osumaa → ±${acc.toFixed(0)}m`);
  return { lat:wLat/wSum, lon:wLon/wSum, acc:Math.max(3,acc), src:'ble-beacon' };
}

async function onlineLocate(wifi, ble) {
  const aps = filterWifi(wifi);
  if (aps.length < CFG.minWifi) { log(`Online: liian vähän AP:ja (${aps.length})`); return null; }
  const wifiPayload = aps.map(ap => ({ macAddress:ap.bssid, signalStrength:ap.level??ap.rssi, channel:ap.frequency?Math.round((ap.frequency-2407)/5):undefined }));
  const blePayload  = filterBle(ble).filter(d=>macValid(d.id)).map(d=>({ macAddress:d.id, signalStrength:Math.round(d.rssi) }));
  const endpoints = [];
  if (GOOGLE_API_KEY) endpoints.push({ name:'Google', url:CFG.googleUrl, body:{ considerIp:false, wifiAccessPoints:wifiPayload, ...(blePayload.length?{bluetoothDevices:blePayload}:{}) } });
  endpoints.push({ name:'BeaconDB', url:CFG.beacondbUrl, body:{ considerIp:false, wifiAccessPoints:wifiPayload, ...(blePayload.length?{bluetoothBeacons:blePayload}:{}) } });
  for (const ep of endpoints) {
    try {
      log(`Online: kokeillaan ${ep.name} (${wifiPayload.length} AP)...`);
      const res = await fetch(ep.url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(ep.body) });
      if (!res.ok) { log(`${ep.name}: HTTP ${res.status}`); continue; }
      const data = await res.json();
      if (data?.location?.lat == null) { log(`${ep.name}: ei koordinaatteja`); continue; }
      const result = { lat:data.location.lat, lon:data.location.lng, acc:Math.max(15,data.accuracy??100), src:ep.name };
      log(`${ep.name}: ✅ ${result.lat.toFixed(5)}, ${result.lon.toFixed(5)} ±${Math.round(result.acc)}m`);
      statusMsg = `${ep.name}: ±${Math.round(result.acc)}m`;
      return result;
    } catch(err) { log(`${ep.name}: ${err.message}`); }
  }
  statusMsg = 'Online-paikannus epäonnistui';
  return null;
}

async function locate() {
  if (!plugin) { log('Ei natiivipluginijä'); return null; }
  await scan();
  const wifi = lastWifi, ble = lastBle;
  const [fpResult, bleResult] = await Promise.all([fingerprintLocate(wifi,ble), beaconLocate(ble)]);
  let local = (fpResult && bleResult) ? (fpResult.acc<=bleResult.acc?fpResult:bleResult) : (fpResult??bleResult??null);
  if (local && local.acc <= CFG.localAccThr) { statusMsg=`${local.src}: ±${Math.round(local.acc)}m`; return local; }
  const online = await onlineLocate(wifi, ble);
  if (!online && !local) return null;
  if (!online) return local;
  if (!local)  return online;
  return online.acc <= local.acc ? online : local;
}

async function saveFingerprint(lat, lon) {
  if (!lat||!lon) { alert('Aseta ensin sijainti kartalta'); return; }
  await scan();
  const signals = buildSignalMap(lastWifi, lastBle);
  if (Object.keys(signals).length===0) { alert('Ei signaaleja – Wi-Fi ja Bluetooth päälle'); return; }
  await dbPut('fingerprints', { lat, lon, signals, ts:Date.now() });
  const all = await dbGetAll('fingerprints');
  log(`Sormenjälki #${all.length} tallennettu`);
  alert(`Tallennettu! Yhteensä: ${all.length} pistettä`);
}

async function exportDb() {
  const [fps,beacons] = await Promise.all([dbGetAll('fingerprints'),dbGetAll('beacons')]);
  const blob = new Blob([JSON.stringify({fingerprints:fps,beacons},null,2)],{type:'application/json'});
  const a = Object.assign(document.createElement('a'),{href:URL.createObjectURL(blob),download:`poma-wireless-${new Date().toISOString().slice(0,10)}.json`});
  a.click(); URL.revokeObjectURL(a.href);
}

async function importDb(file) {
  const data = JSON.parse(await file.text());
  if (data.fingerprints) { await dbClear('fingerprints'); for (const fp of data.fingerprints) await dbPut('fingerprints',fp); }
  if (data.beacons)      { await dbClear('beacons');      for (const b  of data.beacons)      await dbPut('beacons',b); }
  const [fps,beacons] = await Promise.all([dbGetAll('fingerprints'),dbGetAll('beacons')]);
  alert(`Tuotu: ${fps.length} sormenjälkeä, ${beacons.length} majakka`);
}

function log(msg) {
  console.log(`[PomaWireless ${new Date().toTimeString().slice(0,8)}] ${msg}`);
  const el = document.getElementById('wireless-log');
  if (el) el.textContent = msg;
}

async function init(nativePlugin) {
  plugin = nativePlugin;
  db     = await openDb();
  const [fps,beacons] = await Promise.all([dbGetAll('fingerprints'),dbGetAll('beacons')]);
  log(`Alustettu – ${fps.length} sormenjälkeä, ${beacons.length} majakka`);
  document.getElementById('learn-here')?.addEventListener('click', () => {
    saveFingerprint(window.currentLat??window.estimatedLat, window.currentLon??window.estimatedLon);
  });
  document.getElementById('export-db')?.addEventListener('click', exportDb);
  document.getElementById('import-db')?.addEventListener('change', e => { const f=e.target.files?.[0]; if(f) importDb(f); });
  setInterval(scan, CFG.scanInterval);
  await scan();
}

window.PomaWireless = {
  init, locate,
  online: () => statusMsg,
  saveFingerprint, exportDb, importDb,
  getLastWifi: () => lastWifi,
  getLastBle:  () => lastBle,
};
