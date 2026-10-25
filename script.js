/* POMA Pathfinder – app: tabs, compass, map, waypoints, assistant, method switches.
   Positioning logic lives in wireless.js, the Tekoäly tab's answers in ai.js. */
(function () {
  "use strict";
  const E = window.PomaEngine;
  const $ = id => document.getElementById(id);
  const tracker = E.createTracker();
  const stepper = E.createStepDetector();
  const S = tracker.state;
  const RAD = Math.PI / 180;

  let map, marker, circle, trail, trailPts = [], wpLayer, targetLine;
  let heading = null, hv = { s: 0, c: 0, n: 0 };            // smoothed magnetic heading
  let lastScan = null, busy = false, tracking = false, netTimer = null, wakeLock = null, absSeen = false;
  let compassOn = false, motionOn = false, gpsWatch = null, lastProblems = [], lastSave = 0;
  let waypoints = [], targetId = null, tab = "nav";

  /* ---------------------------------------------------------------- storage helpers */
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };

  /* ---------------------------------------------------------------- method switches */
  const DEFAULTS = { gps: false, wifi: true, cells: true, ble: true, online: true, learned: true, pdr: true };
  const METHOD_NAMES = { gps: "GPS", wifi: "Wi-Fi", cells: "mobiiliasemat", ble: "Bluetooth", online: "verkkotietokanta", learned: "opitut paikat", pdr: "askeleet ja kompassi" };
  const M = Object.assign({}, DEFAULTS, load("poma.methods.v1", {}));
  const radioOn = () => M.wifi || M.cells || M.ble;

  /* ---------------------------------------------------------------- log */
  const lines = [];
  function log(msg) {
    lines.push(new Date().toTimeString().slice(0, 8) + "  " + msg);
    if (lines.length > 150) lines.shift();
    const el = $("log"); if (el) { el.textContent = lines.join("\n"); el.scrollTop = el.scrollHeight; }
    console.log("[Poma] " + msg);
  }
  function copyLog() {
    const ta = document.createElement("textarea");
    ta.value = lines.join("\n"); document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch (e) { /* ignore */ }
    ta.remove(); toast(ok ? "Loki kopioitu" : "Kopiointi ei onnistunut, valitse teksti käsin");
  }
  const errText = e => String((e && (e.message || e.errorMessage)) || e);
  let toastTimer;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  /* ---------------------------------------------------------------- settings */
  const stepLen = () => Math.min(230, Math.max(100, +$("set-height").value || 175)) * 0.00415;   // metres
  const declination = () => +$("set-decl").value || 0;
  const trueHeading = () => heading == null ? null : E.norm360(heading + declination());
  const fmtDist = m => m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + " km" : Math.round(m) + " m";
  const fmtAcc = m => "±" + fmtDist(m);
  const turnText = t => { const a = Math.abs(Math.round(t)); return a <= 15 ? "suoraan eteenpäin" : a >= 165 ? "käänny ympäri" : "käänny " + (t > 0 ? "oikealle" : "vasemmalle") + " " + a + "°"; };

  /* ---------------------------------------------------------------- sheet (bottom dialog) */
  function openSheet(o) {
    $("sheet-title").textContent = o.title || ""; $("sheet-text").textContent = o.text || "";
    const inp = $("sheet-input"); inp.hidden = !o.input; inp.value = o.input ? (o.input.value || "") : ""; inp.placeholder = o.input ? o.input.placeholder || "" : "";
    const box = $("sheet-btns"); box.innerHTML = "";
    (o.buttons || []).forEach(b => {
      const el = document.createElement("button"); el.className = "btn " + (b.cls || ""); el.textContent = b.label;
      el.addEventListener("click", () => { const v = inp.value.trim(); closeSheet(); if (b.onClick) b.onClick(v); });
      box.appendChild(el);
    });
    $("sheet").hidden = false; if (o.input) setTimeout(() => inp.focus(), 80);
  }
  const closeSheet = () => { $("sheet").hidden = true; };

  /* ---------------------------------------------------------------- tabs */
  function switchTab(name) {
    tab = name;
    document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + name));
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
    $("main").classList.toggle("nopad", name === "map");
    if (name === "map" && map) setTimeout(() => { map.invalidateSize(); if (S.has && !map._poma) { map.setView([S.lat, S.lon], Math.max(map.getZoom(), 15)); map._poma = 1; } }, 60);
    if (name === "ai") scrollChat();
    stats();
  }

  /* ---------------------------------------------------------------- waypoints */
  function wpInfo(w) {
    if (!S.has) return null;
    const b = E.bearing(S, w), th = trueHeading();
    return { dist: E.distM(S, w), bearing: b, cardinal: E.cardinalFi(b), turn: th == null ? 0 : E.turnAngle(th, b) };
  }
  function addWaypoint(lat, lon, suggested) {
    openSheet({
      title: "Uusi reittipiste", text: lat.toFixed(5) + ", " + lon.toFixed(5),
      input: { placeholder: "Nimi, esim. Auto", value: suggested || "Piste " + (waypoints.length + 1) },
      buttons: [
        { label: "Tallenna", cls: "primary", onClick: name => {
          waypoints.push({ id: Date.now(), name: name || "Piste " + (waypoints.length + 1), lat, lon }); save("poma.waypoints.v1", waypoints);
          log("Reittipiste tallennettu: " + name); toast("Reittipiste tallennettu"); renderWaypoints(); drawWaypoints(); } },
        { label: "Peruuta" }]
    });
  }
  function deleteWaypoint(id) {
    waypoints = waypoints.filter(w => w.id !== id); if (targetId === id) targetId = null;
    save("poma.waypoints.v1", waypoints); renderWaypoints(); drawWaypoints(); stats();
  }
  function setTarget(id) { targetId = targetId === id ? null : id; renderWaypoints(); drawWaypoints(); stats(); if (targetId) toast("Opastus päällä"); }
  function renderWaypoints() {
    const box = $("wp-list"); box.innerHTML = "";
    if (!waypoints.length) { box.innerHTML = '<div class="empty">Ei reittipisteitä. Tallenna nykyinen paikka tai napauta karttaa.</div>'; return; }
    waypoints.forEach(w => {
      const i = wpInfo(w), el = document.createElement("div"); el.className = "wp" + (w.id === targetId ? " active" : "");
      el.innerHTML = '<svg class="ic"><use href="#i-flag"/></svg><div class="wp-t"><div class="wp-n"></div><div class="wp-d"></div></div>' +
        '<button class="go"></button><button class="icon-btn del" aria-label="Poista"><svg class="ic"><use href="#i-trash-2"/></svg></button>';
      el.querySelector(".wp-n").textContent = w.name;
      el.querySelector(".wp-d").textContent = i ? "Suunta " + Math.round(i.bearing) + "° " + i.cardinal + " · " + fmtDist(i.dist) : w.lat.toFixed(4) + ", " + w.lon.toFixed(4);
      const go = el.querySelector(".go"); go.textContent = w.id === targetId ? "Lopeta" : "Opasta"; go.addEventListener("click", () => setTarget(w.id));
      el.querySelector(".del").addEventListener("click", () => openSheet({ title: "Poistetaanko \"" + w.name + "\"?", buttons: [{ label: "Poista", cls: "danger", onClick: () => deleteWaypoint(w.id) }, { label: "Peruuta" }] }));
      box.appendChild(el);
    });
  }

  /* ---------------------------------------------------------------- map */
  function initMap() {
    if (!window.L) { $("map").innerHTML = '<p class="muted" style="padding:80px 24px;text-align:center">Karttaa ei voitu ladata. Tarvitaan internet ensimmäisellä kerralla.</p>'; return; }
    map = L.map("map", { zoomControl: true }).setView([64.5, 26], 5);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
    trail = L.polyline([], { color: "#38BDF8", weight: 4, opacity: .9 }).addTo(map);
    wpLayer = L.layerGroup().addTo(map);
    map.on("click", e => {
      const { lat, lng } = e.latlng;
      openSheet({ title: "Valittu piste", text: lat.toFixed(5) + ", " + lng.toFixed(5), buttons: [
        { label: "Aseta tämä sijainnikseni", cls: "primary", onClick: () => { tracker.setPosition(lat, lng, 10, "käsin asetettu"); trailPts = []; log("Sijainti asetettu käsin kartalta"); draw(true); stats(); toast("Sijainti asetettu"); } },
        { label: "Lisää reittipiste tähän", onClick: () => addWaypoint(lat, lng) },
        { label: "Peruuta" }] });
    });
    drawWaypoints();
  }
  function draw(recenter) {
    if (!map || !S.has) return;
    const ll = [S.lat, S.lon];
    if (!marker) {
      marker = L.marker(ll, { icon: L.divIcon({ className: "", html: '<div class="me"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }), zIndexOffset: 1000 }).addTo(map);
      circle = L.circle(ll, { radius: S.sigma, color: "#38BDF8", weight: 1, fillOpacity: 0.1 }).addTo(map);
    }
    marker.setLatLng(ll); circle.setLatLng(ll); circle.setRadius(Math.max(3, S.sigma));
    trailPts.push(ll); if (trailPts.length > 2000) trailPts.shift(); trail.setLatLngs(trailPts);
    if (recenter) {
      const z = S.sigma > 3000 ? 12 : S.sigma > 400 ? 14 : S.sigma > 80 ? 16 : 18;
      map.setView(ll, Math.max(map.getZoom(), z)); map._poma = 1;
    }
    drawWaypoints();
    if (Date.now() - lastSave > 5000) { lastSave = Date.now(); save("poma.last.v1", { lat: S.lat, lon: S.lon, sigma: S.sigma, t: Date.now() }); }
  }
  function drawWaypoints() {
    if (!map) return;
    wpLayer.clearLayers();
    waypoints.forEach(w => {
      const on = w.id === targetId;
      L.marker([w.lat, w.lon], { icon: L.divIcon({ className: "", html: '<div class="wp-pin' + (on ? " on" : "") + '"></div>', iconSize: [26, 26], iconAnchor: [4, 26] }) })
        .bindTooltip(w.name, { direction: "top", offset: [8, -22] }).addTo(wpLayer);
    });
    if (targetLine) { map.removeLayer(targetLine); targetLine = null; }
    const t = waypoints.find(w => w.id === targetId);
    if (t && S.has) targetLine = L.polyline([[S.lat, S.lon], [t.lat, t.lon]], { color: "#F97316", weight: 3, dashArray: "6 8" }).addTo(map);
  }

  /* ---------------------------------------------------------------- UI refresh */
  function banner(text) { $("banner").hidden = !text; $("banner-text").textContent = text || ""; }
  function stats() {
    const th = trueHeading();
    // compass
    $("head-deg").textContent = th == null ? "–" : Math.round(th); $("head-degsign").hidden = th == null;
    $("head-dir").textContent = th == null ? "EI KOMPASSIA" : E.cardinalFi(th);
    $("head-sub").textContent = !M.pdr ? "Askeleet ja kompassi on pois päältä (Asetukset)" : th == null ? "Odotetaan kompassia… pidä puhelinta kädessä" : "Magneettinen pohjoinen + korjaus " + (declination() >= 0 ? "+" : "") + declination() + "°";
    $("ring").style.transform = "rotate(" + (th == null ? 0 : -th) + "deg)";
    // target
    const t = waypoints.find(w => w.id === targetId), g = $("guide"), tm = $("tmark");
    tm.hidden = true; g.className = "guide";
    if (t && S.has) {
      const i = wpInfo(t); tm.hidden = false; tm.style.transform = "rotate(" + i.bearing + "deg)";
      if (i.dist < 10) { g.textContent = "Perillä: " + t.name; g.classList.add("arrived"); }
      else { g.textContent = t.name + " · " + fmtDist(i.dist) + " · " + (th == null ? "suunta " + Math.round(i.bearing) + "° " + i.cardinal : turnText(i.turn)); g.classList.add("target"); }
    } else if (t) g.textContent = t.name + ": odotetaan sijaintia";
    else g.textContent = "Ei kohdetta. Valitse reittipiste alta ja paina Opasta.";
    // cards
    $("sos-pos").textContent = S.has ? "Kerro sijaintisi: " + S.lat.toFixed(5) + ", " + S.lon.toFixed(5) + " (" + fmtAcc(S.sigma) + ")" : "Avaa puhelimen soittonäppäimistön numerolla 112";
    $("n-pos").textContent = S.has ? S.lat.toFixed(5) + ", " + S.lon.toFixed(5) : "ei vielä";
    $("n-acc").textContent = S.has ? fmtAcc(S.sigma) : "–"; $("n-src").textContent = S.src || "Paina Paikanna";
    $("n-steps").textContent = S.steps; $("n-meters").textContent = Math.round(S.meters) + " m kuljettu";
    const pill = $("pill-src"); $("pill-src-text").textContent = S.has ? S.src.replace("viimeisin tunnettu","viim. tunnettu") + " " + fmtAcc(S.sigma) : "Ei sijaintia";
    pill.className = "pill" + (S.has ? (S.sigma < 100 ? " ok" : " warn") : "");
    // settings
    if (lastScan) $("s-scan").textContent = lastScan.wifi.length + " / " + lastScan.ble.length + " / " + lastScan.cells.length;
    $("s-msg").textContent = E.message() || "–";
    const n = E.counts().fingerprints; $("fp-count").textContent = n + (n === 1 ? " opittu paikka" : " opittua paikkaa");
    if (tab === "nav") renderWaypointsLive();
  }
  function renderWaypointsLive() {   // refresh distances without rebuilding buttons
    const rows = document.querySelectorAll("#wp-list .wp");
    waypoints.forEach((w, k) => { const r = rows[k]; if (!r) return; const i = wpInfo(w);
      if (i) r.querySelector(".wp-d").textContent = "Suunta " + Math.round(i.bearing) + "° " + i.cardinal + " · " + fmtDist(i.dist); });
  }
  function checkStatus(st) {
    if (!st) return;
    $("s-dev").textContent = st.device + " · Android API " + st.sdk;
    const p = [];
    if (!st.locationPermission) p.push("Anna sovellukselle sijaintilupa (tarvitaan Wi-Fi- ja asematietojen lukemiseen).");
    if (!st.locationServicesOn) p.push("Laita puhelimen Sijainti-asetus päälle. Android estää muuten Wi-Fi- ja asematiedot kaikilta sovelluksilta. GPS:ää sovellus käyttää vain jos GPS-kytkin on päällä.");
    if (M.wifi && !st.wifiEnabled) p.push("Laita Wi-Fi päälle (ei tarvitse olla yhdistettynä).");
    if (M.cells && !st.hasTelephony) p.push("Laitteessa ei ole matkapuhelinyhteyttä, solupaikannus ei käytössä.");
    lastProblems = p; banner(p.join(" "));
  }

  /* ---------------------------------------------------------------- GPS (optional) */
  const GPS_ERR = { 1: "lupa evätty", 2: "ei saatavilla (satelliitteja ei näy tai Sijainti on pois)", 3: "aikakatkaisu" };
  function onGps(pos) {
    const c = pos.coords;
    if (c.accuracy > 200) { log("GPS-piste hylätty, liian epätarkka (" + Math.round(c.accuracy) + " m)"); return null; }
    const fix = { lat: c.latitude, lon: c.longitude, acc: Math.max(3, c.accuracy), src: "GPS" };
    const r = tracker.fuse(fix);
    log("GPS: " + fix.lat.toFixed(5) + ", " + fix.lon.toFixed(5) + " " + fmtAcc(fix.acc));
    draw(r === "set"); stats(); return fix;
  }
  function gpsOnce() {
    return new Promise(resolve => {
      if (!navigator.geolocation) { log("GPS ei käytettävissä tässä näkymässä"); return resolve(null); }
      navigator.geolocation.getCurrentPosition(p => resolve(onGps(p)), e => { log("GPS: " + (GPS_ERR[e.code] || e.message)); resolve(null); },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
    });
  }
  function startGpsWatch() {
    if (gpsWatch != null || !navigator.geolocation) return;
    gpsWatch = navigator.geolocation.watchPosition(onGps, e => log("GPS: " + (GPS_ERR[e.code] || e.message)), { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
    log("GPS-seuranta päällä");
  }
  function stopGpsWatch() { if (gpsWatch == null) return; navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; log("GPS-seuranta pois"); }

  /* ---------------------------------------------------------------- positioning */
  async function radioFix(reason) {
    if (!radioOn()) return null;
    if (!E.available()) { banner("Radioskannaus toimii vain Android-sovelluksessa (ei selaimessa)."); log("Ei natiivipluginia"); return null; }
    log("Radiohaku (" + reason + "): " + ["wifi", "cells", "ble"].filter(k => M[k]).map(k => METHOD_NAMES[k]).join(", "));
    const st = await E.prepare(); checkStatus(st);
    const sc = lastScan = await E.scan({ wifi: M.wifi, ble: M.ble, cells: M.cells });
    log("Skannaus: " + sc.wifi.length + " Wi-Fi (" + (sc.wifiRaw || 0) + " raakana" + (sc.throttled ? ", Android rajoitti" : "") + "), " + sc.ble.length + " BLE, " + sc.cells.length + " solua" + (sc.errors.length ? " | virheet: " + sc.errors.join("; ") : ""));
    const fix = await E.locate(sc, { learned: M.learned, online: M.online });
    if (!fix) { log("Radioilla ei sijaintia: " + E.message()); return null; }
    const r = tracker.fuse(fix);
    log("Sijainti: " + fix.lat.toFixed(5) + ", " + fix.lon.toFixed(5) + " " + fmtAcc(fix.acc) + " (" + fix.src + ")");
    draw(r === "set"); return fix;
  }
  async function locateNow(reason) {
    if (busy) return;
    if (!M.gps && !radioOn()) { log("Kaikki hakumenetelmät ovat pois päältä"); banner("Kytke vähintään yksi paikannusmenetelmä päälle (GPS, Wi-Fi, mobiiliasemat tai Bluetooth) Asetuksissa."); return; }
    busy = true; $("btn-locate").disabled = true;
    try { await Promise.all([M.gps ? gpsOnce() : null, radioFix(reason).catch(e => log("Virhe: " + errText(e)))]); }
    catch (e) { log("Virhe: " + errText(e)); }
    finally { busy = false; $("btn-locate").disabled = false; stats(); renderWaypoints(); if (!S.has) toast("Sijaintia ei löytynyt: katso Asetukset → Viimeisin haku"); }
  }
  async function learnHere() {
    if (!S.has) { toast("Aseta ensin sijainti: napauta karttaa tai paina Paikanna"); return; }
    if (!E.available()) { toast("Oppiminen toimii vain Android-sovelluksessa"); return; }
    if (!radioOn()) { toast("Kytke Wi-Fi, mobiiliasemat tai Bluetooth päälle"); return; }
    const doLearn = async () => {
      const sc = (lastScan && Date.now() - lastScan.t < 20000) ? lastScan : (lastScan = await E.scan({ wifi: M.wifi, ble: M.ble, cells: M.cells }));
      const ok = E.learn(S.lat, S.lon, sc);
      log(ok ? "Paikka opittu (" + E.counts().fingerprints + " yhteensä)" : "Liian vähän signaaleja opittavaksi");
      toast(ok ? "Paikka opittu" : "Liian vähän signaaleja (tarvitaan vähintään 3)"); stats();
    };
    if (S.sigma > 30) openSheet({ title: "Sijainti on epätarkka", text: "Tarkkuus on vain " + fmtAcc(S.sigma) + ". Opittu paikka on yhtä väärä. Napauta ensin kartalta täsmälleen se kohta, jossa seisot.",
      buttons: [{ label: "Opi silti", onClick: doLearn }, { label: "Peruuta" }] });
    else doLearn();
  }

  /* ---------------------------------------------------------------- compass + step sensors */
  function onOrientation(ev) {
    if (ev.type === "deviceorientation" && absSeen) return;
    if (ev.type === "deviceorientationabsolute") absSeen = true;
    let h = null;
    if (typeof ev.webkitCompassHeading === "number") h = ev.webkitCompassHeading;
    else if (ev.alpha != null && ev.beta != null && ev.gamma != null && (ev.absolute || ev.type === "deviceorientationabsolute")) h = E.headingFromEuler(ev.alpha, ev.beta, ev.gamma);
    if (h == null) return;
    hv.s = hv.n ? 0.85 * hv.s + 0.15 * Math.sin(h * RAD) : Math.sin(h * RAD);
    hv.c = hv.n ? 0.85 * hv.c + 0.15 * Math.cos(h * RAD) : Math.cos(h * RAD);
    hv.n++; heading = E.norm360(Math.atan2(hv.s, hv.c) / RAD);
  }
  function onMotion(ev) {
    const a = ev.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    if (stepper.feed(performance.now(), a.x, a.y, a.z)) { if (tracker.step(trueHeading(), stepLen())) draw(false); stats(); }
  }
  async function askMotionPermission() {      // iOS-style WebViews only
    try {
      if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === "function") await DeviceMotionEvent.requestPermission();
      if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === "function") await DeviceOrientationEvent.requestPermission();
    } catch (e) { log("Liikeanturilupa: " + errText(e)); }
  }
  async function setCompass(on) {
    if (on === compassOn) return; compassOn = on;
    if (on) { await askMotionPermission(); window.addEventListener("deviceorientationabsolute", onOrientation, true); window.addEventListener("deviceorientation", onOrientation, true); log("Kompassi päällä"); }
    else { window.removeEventListener("deviceorientationabsolute", onOrientation, true); window.removeEventListener("deviceorientation", onOrientation, true); hv = { s: 0, c: 0, n: 0 }; heading = null; log("Kompassi pois"); }
  }
  function setMotion(on) {
    if (on === motionOn) return; motionOn = on;
    if (on) window.addEventListener("devicemotion", onMotion, true); else window.removeEventListener("devicemotion", onMotion, true);
    log(on ? "Askelseuranta päällä" : "Askelseuranta pois");
  }
  function applyMethods() {
    setCompass(M.pdr); setMotion(tracking && M.pdr);
    if (tracking && M.gps) startGpsWatch(); else stopGpsWatch();
    stats();
  }
  async function startTracking() {
    if (!M.gps && !radioOn() && !M.pdr) { toast("Kytke vähintään yksi menetelmä päälle"); return; }
    tracking = true; $("btn-track").classList.add("on"); $("btn-track-t").textContent = "Seuranta päällä";
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { /* optional */ }
    log("Seuranta päällä"); applyMethods();
    if (M.gps || radioOn()) locateNow("seuranta alkoi");
    netTimer = setInterval(() => { if (radioOn()) locateNow("ajastettu"); }, 30000);
  }
  function stopTracking() {
    tracking = false; clearInterval(netTimer); try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignore */ }
    $("btn-track").classList.remove("on"); $("btn-track-t").textContent = "Seuranta"; log("Seuranta pysäytetty"); applyMethods();
  }

  /* ---------------------------------------------------------------- Tekoäly tab */
  function aiContext() {
    const th = trueHeading();
    return {
      pos: S.has ? { lat: S.lat, lon: S.lon } : null, sigma: S.sigma, src: S.src, steps: S.steps, meters: S.meters, stepLen: stepLen(), heading: th,
      scan: lastScan ? { wifi: lastScan.wifi.length, ble: lastScan.ble.length, cells: lastScan.cells.length, throttled: lastScan.throttled } : null,
      message: E.message(), methods: M, problems: lastProblems, target: targetId,
      waypoints: S.has ? waypoints.map(w => { const i = wpInfo(w); return { id: w.id, name: w.name, dist: i.dist, bearing: i.bearing, cardinal: i.cardinal, turn: i.turn }; }) : waypoints.map(w => ({ id: w.id, name: w.name }))
    };
  }
  function addMsg(who, text, img) {
    const el = document.createElement("div"); el.className = "msg " + who;
    if (img) { const im = document.createElement("img"); im.src = img; el.appendChild(im); }
    el.appendChild(document.createTextNode(text)); $("chat").appendChild(el); scrollChat(); return el;
  }
  const scrollChat = () => { const c = $("chat"); setTimeout(() => { c.scrollTop = c.scrollHeight; }, 30); };
  let aiCaps = { vision: false, audio: false }, aiBusy = false, recorder = null;
  async function askAI(text, image, audio) {
    if (!text && !image && !audio) return;
    if (aiBusy) { toast("Edellinen kysymys on vielä kesken"); return; }
    addMsg("me", text || (audio ? "(puhe)" : "(kuva)"), image);
    const wait = addMsg("ai", "Mietin…");
    const model = window.PomaAI.info().mode === "model";
    let t0 = Date.now(), tick = null;
    if (model) tick = setInterval(() => { wait.textContent = "Mietin… " + Math.round((Date.now() - t0) / 1000) + " s"; }, 1000);
    aiBusy = true;
    try {
      const r = await window.PomaAI.ask({ text, image, audio }, aiContext());
      wait.textContent = r.text; if (model) log("AI vastasi " + Math.round((Date.now() - t0) / 1000) + " s");
    } finally { aiBusy = false; clearInterval(tick); }
    scrollChat();
  }
  // Downscale the photo (the model works at <= 768 px anyway) and send it as JPEG.
  function pickImage() {
    const f = document.createElement("input"); f.type = "file"; f.accept = "image/*";
    f.onchange = () => {
      const file = f.files && f.files[0]; if (!file) return;
      const url = URL.createObjectURL(file), im = new Image();
      im.onload = () => {
        const k = Math.min(1, 768 / Math.max(im.width, im.height)), c = document.createElement("canvas");
        c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
        c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        const data = c.toDataURL("image/jpeg", 0.85), q = $("ai-input").value.trim(); $("ai-input").value = "";
        askAI(q, data);
      };
      im.onerror = () => { URL.revokeObjectURL(url); toast("Kuvan lukeminen epäonnistui"); };
      im.src = url;
    };
    f.click();
  }
  async function toggleMic() {
    if (recorder) {
      const r = recorder; recorder = null; $("ai-mic").classList.remove("rec");
      try { const wav = await r.stop(); askAI($("ai-input").value.trim(), null, wav); $("ai-input").value = ""; }
      catch (e) { toast(errText(e)); }
      return;
    }
    try { recorder = window.PomaAI.createRecorder(); await recorder.start(); $("ai-mic").classList.add("rec"); toast("Kuuntelen… paina mikkiä uudelleen kun olet valmis"); }
    catch (e) { recorder = null; $("ai-mic").classList.remove("rec"); toast("Mikrofoni ei auennut: " + errText(e)); log("Mikrofoni: " + errText(e)); }
  }
  function aiHeader() {
    const i = window.PomaAI.info(); $("ai-name").textContent = i.name;
    const m = $("ai-mode"); m.textContent = i.mode === "model" ? "Paikallinen malli" : "Ei tekoälymallia"; m.className = "chip " + (i.mode === "model" ? "ok" : "warn");
    $("ai-mic").classList.toggle("off", !(i.mode === "model" && aiCaps.audio)); $("ai-img").classList.toggle("off", !(i.mode === "model" && aiCaps.vision));
    $("ai-note").textContent = i.mode === "model"
      ? "Malli pyörii puhelimessa ilman nettiä. Se saa sovelluksen tilan mukaan" + (aiCaps.vision ? ", voit liittää kuvan" : "") + (aiCaps.audio ? " ja puhua" : "") + "."
      : "Vastaa sovelluksen tilan perusteella (sijainti, tarkkuus, reittipisteet). Kuvat ja puhe vaativat paikallisen mallin.";
  }

  /* ---- local model management (Asetukset) ---- */
  const NA = () => window.PomaAI.native;
  let aiLoading = false, aiStatus = null;
  async function aiModelRefresh() {
    const st = $("ai-m-status"), has = NA().available();
    aiStatus = has ? await NA().status() : null;
    const dis = x => ["btn-ai-pick", "btn-ai-load", "btn-ai-del", "ai-gpu"].forEach(id => { $(id).disabled = x; });
    if (!aiStatus) {
      st.textContent = has ? "Tekoälymoduuli ei ole mukana tässä sovellusversiossa." : "Paikallinen malli toimii vain Android-sovelluksessa.";
      dis(true); $("btn-ai-goto").hidden = true; return;
    }
    const s = aiStatus, loaded = window.PomaAI.info().mode === "model";
    const ram = (s.totalRamMb / 1024).toFixed(1).replace(".", ",") + " Gt";
    let t = "Puhelimen muisti " + ram + ", vapaata tilaa " + Math.round(s.freeDiskMb / 1024) + " Gt. ";
    if (!s.modelExists) t += "Mallia ei ole vielä puhelimessa.";
    else t += "Malli puhelimessa (" + (s.modelMb / 1024).toFixed(1).replace(".", ",") + " Gt). " + (loaded ? "Ladattu muistiin" + (aiCaps.vision ? ", kuvat" : "") + (aiCaps.audio ? ", puhe" : "") + " käytössä." : "Ei vielä ladattu muistiin.");
    if (s.totalRamMb < 5500) t += " Varoitus: muistia on vähän, malli voi kaatua tai olla hidas.";
    st.textContent = t; dis(aiLoading);
    $("btn-ai-load").textContent = loaded ? "Pura muistista" : "Lataa muistiin"; $("btn-ai-load").disabled = aiLoading || !s.modelExists;
    $("btn-ai-del").disabled = aiLoading || !s.modelExists;
    $("btn-ai-goto").hidden = loaded; $("btn-ai-goto").textContent = s.modelExists ? "Lataa tekoälymalli" : "Asenna tekoälymalli";
  }
  async function aiLoadToggle() {
    if (aiLoading) return;
    if (window.PomaAI.info().mode === "model") {
      await NA().unload(); window.PomaAI.native.detach(); aiCaps = { vision: false, audio: false }; log("Malli purettu muistista"); aiHeader(); aiModelRefresh(); return;
    }
    aiLoading = true; $("btn-ai-load").textContent = "Ladataan… (voi kestää minuutin)"; $("btn-ai-load").disabled = true; log("Ladataan mallia" + ($("ai-gpu").checked ? " (GPU)" : "") + "…");
    try {
      const r = await NA().load($("ai-gpu").checked);
      aiCaps = { vision: !!r.vision, audio: !!r.audio }; NA().attach("Gemma 3n (paikallinen)");
      log("Malli ladattu: " + r.mode + (r.warnings ? " | huom: " + r.warnings : "")); toast("Malli valmis (" + r.mode + ")");
    } catch (e) { log("Mallin lataus epäonnistui: " + errText(e)); openSheet({ title: "Mallin lataus epäonnistui", text: errText(e) + "\n\nKopioi loki Asetuksista ja lähetä se kehittäjälle.", buttons: [{ label: "Sulje" }] }); }
    aiLoading = false; aiHeader(); aiModelRefresh();
  }
  async function aiPick() {
    if (aiLoading) return;
    aiLoading = true; $("btn-ai-pick").disabled = true; $("ai-m-prog").hidden = false; $("ai-m-bar").style.width = "0";
    let h = NA().onProgress(p => { const pct = p.totalMb ? Math.min(100, Math.round(100 * p.mb / p.totalMb)) : 0; $("ai-m-bar").style.width = pct + "%"; $("ai-m-status").textContent = "Kopioidaan mallia… " + p.mb + (p.totalMb ? " / " + p.totalMb : "") + " Mt"; });
    try {
      if (window.PomaAI.info().mode === "model") { await NA().unload(); NA().detach(); aiCaps = { vision: false, audio: false }; }
      const r = await NA().pick(); log("Malli kopioitu: " + r.name + " " + r.mb + " Mt"); toast("Malli tallennettu. Paina Lataa muistiin.");
    } catch (e) { if (!/ei valittu/i.test(errText(e))) openSheet({ title: "Mallin tuonti epäonnistui", text: errText(e), buttons: [{ label: "Sulje" }] }); log("Mallin tuonti: " + errText(e)); }
    try { h && h.then ? (await h).remove() : h && h.remove && h.remove(); } catch (e) { /* ignore */ }
    $("ai-m-prog").hidden = true; aiLoading = false; aiHeader(); aiModelRefresh();
  }
  function aiDelete() {
    openSheet({ title: "Poistetaanko malli?", text: "Malli vie useita gigatavuja. Voit tuoda sen myöhemmin uudelleen.", buttons: [
      { label: "Poista malli", cls: "danger", onClick: async () => { try { await NA().remove(); NA().detach(); aiCaps = { vision: false, audio: false }; log("Malli poistettu"); } catch (e) { toast(errText(e)); } aiHeader(); aiModelRefresh(); } }, { label: "Peruuta" }] });
  }

  /* ---------------------------------------------------------------- start */
  document.addEventListener("DOMContentLoaded", async () => {
    waypoints = load("poma.waypoints.v1", []);
    initMap(); renderWaypoints();
    const last = load("poma.last.v1", null);
    if (last && last.lat != null) { tracker.setPosition(last.lat, last.lon, Math.max(300, last.sigma), "viimeisin tunnettu"); draw(true); }

    document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => switchTab(t.dataset.tab)));
    document.querySelectorAll("input[data-m]").forEach(cb => {
      cb.checked = !!M[cb.dataset.m];
      cb.addEventListener("change", () => { M[cb.dataset.m] = cb.checked; save("poma.methods.v1", M); log(METHOD_NAMES[cb.dataset.m] + (cb.checked ? " päälle" : " pois")); applyMethods(); });
    });
    ["set-height", "set-decl"].forEach(id => { const v = load("poma." + id, null); if (v != null) $(id).value = v; $(id).addEventListener("change", () => { save("poma." + id, $(id).value); stats(); }); });
    $("btn-locate").addEventListener("click", () => locateNow("käsin"));
    $("btn-track").addEventListener("click", () => (tracking ? stopTracking() : startTracking()));
    $("btn-addwp").addEventListener("click", () => S.has ? addWaypoint(S.lat, S.lon) : toast("Aseta ensin sijainti: paina Paikanna tai napauta karttaa"));
    $("map-addwp").addEventListener("click", () => S.has ? addWaypoint(S.lat, S.lon) : toast("Sijaintia ei vielä ole"));
    $("map-center").addEventListener("click", () => { if (S.has && map) map.setView([S.lat, S.lon], Math.max(map.getZoom(), 16)); else toast("Sijaintia ei vielä ole"); });
    $("btn-learn").addEventListener("click", learnHere);
    $("btn-forget").addEventListener("click", () => openSheet({ title: "Unohdetaanko kaikki opitut paikat?", text: "Tätä ei voi perua.", buttons: [{ label: "Unohda kaikki", cls: "danger", onClick: () => { E.clearFingerprints(); stats(); toast("Opitut paikat poistettu"); } }, { label: "Peruuta" }] }));
    $("btn-copylog").addEventListener("click", copyLog);
    $("banner-x").addEventListener("click", () => banner(""));
    $("sheet").addEventListener("click", e => { if (e.target === $("sheet")) closeSheet(); });
    $("composer").addEventListener("submit", e => { e.preventDefault(); const t = $("ai-input").value.trim(); $("ai-input").value = ""; askAI(t); });
    $("chips").addEventListener("click", e => { const q = e.target.dataset && e.target.dataset.q; if (q) askAI(q); });
    $("ai-img").addEventListener("click", () => window.PomaAI.info().mode === "model" && aiCaps.vision ? pickImage() : toast("Kuvat vaativat ladatun paikallisen mallin (Asetukset → Tekoälymalli)"));
    $("ai-mic").addEventListener("click", () => window.PomaAI.info().mode === "model" && aiCaps.audio ? toggleMic() : toast("Puhe vaatii ladatun paikallisen mallin (Asetukset → Tekoälymalli)"));
    $("btn-ai-pick").addEventListener("click", aiPick); $("btn-ai-load").addEventListener("click", aiLoadToggle); $("btn-ai-del").addEventListener("click", aiDelete);
    $("btn-ai-goto").addEventListener("click", () => { if (aiStatus && aiStatus.modelExists) { aiLoadToggle(); } else { switchTab("settings"); setTimeout(() => $("ai-card").scrollIntoView({ behavior: "smooth" }), 80); } });
    aiHeader(); aiModelRefresh();
    addMsg("ai", "Hei! Olen navigointiapuri. Kerron missä olet, miksi tarkkuus on mikä on ja mihin suuntaan reittipisteesi ovat. Ilman ladattua mallia vastaan sovelluksen tietojen perusteella; paikallinen malli ymmärtää myös kuvia ja puhetta.");

    setInterval(stats, 1500);
    applyMethods();
    log("Käynnistetty. Natiiviplugin: " + (E.available() ? "löytyi" : "ei (selain)") + ". Päällä: " + Object.keys(M).filter(k => M[k]).map(k => METHOD_NAMES[k]).join(", "));
    if (E.available()) { try { checkStatus(await E.status()); } catch (e) { log("Tilan luku epäonnistui: " + errText(e)); } }
    else banner("Radioskannaus toimii vain Android-sovelluksessa. Selaimessa näet vain kartan (GPS-kytkin toimii myös selaimessa).");
    stats();
  });
})();
