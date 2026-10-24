/* Poma Pathfinder – app: map, sensors and buttons. Positioning logic lives in wireless.js. */
(function () {
  "use strict";
  const E = window.PomaEngine;
  const $ = id => document.getElementById(id);
  const tracker = E.createTracker();
  const stepper = E.createStepDetector();
  const S = tracker.state;

  let map, marker, circle, trail, trailPts = [];
  let heading = null, hv = { s: 0, c: 0, n: 0 };          // smoothed magnetic heading
  let lastScan = null, busy = false, tracking = false, netTimer = null, wakeLock = null, absSeen = false;
  const RAD = Math.PI / 180;

  /* ---------------------------------------------------------------- log (visible in the app) */
  const lines = [];
  function log(msg) {
    const t = new Date().toTimeString().slice(0, 8);
    lines.push(t + "  " + msg);
    if (lines.length > 120) lines.shift();
    const el = $("log");
    if (el) { el.textContent = lines.join("\n"); el.scrollTop = el.scrollHeight; }
    console.log("[Poma] " + msg);
  }
  function copyLog() {
    const ta = document.createElement("textarea");
    ta.value = lines.join("\n"); document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch (e) { /* ignore */ }
    ta.remove(); log(ok ? "Loki kopioitu leikepöydälle" : "Kopiointi ei onnistunut, valitse teksti käsin");
  }

  /* ---------------------------------------------------------------- settings */
  const stepLen = () => Math.min(230, Math.max(100, +$("set-height").value || 175)) * 0.00415;   // metres
  const declination = () => +$("set-decl").value || 0;
  const trueHeading = () => heading == null ? null : E.norm360(heading + declination());

  /* ---------------------------------------------------------------- map */
  function initMap() {
    if (!window.L) { $("map").insertAdjacentHTML("beforeend", '<p class="hint" style="padding:24px">Karttaa ei voitu ladata (tarvitsee internetin ensimmäisellä kerralla).</p>'); return; }
    map = L.map("map", { zoomControl: true }).setView([64.5, 26], 5);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
    trail = L.polyline([], { color: "#4cc9a0", weight: 4 }).addTo(map);
    map.on("click", e => {
      tracker.setPosition(e.latlng.lat, e.latlng.lng, 10, "käsin asetettu");
      log("Lähtöpiste asetettu käsin kartalta");
      trailPts = []; draw(true);
    });
  }
  function draw(recenter) {
    if (!map || !S.has) return;
    const ll = [S.lat, S.lon];
    if (!marker) {
      marker = L.marker(ll, { icon: L.divIcon({ className: "", html: '<div class="me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(map);
      circle = L.circle(ll, { radius: S.sigma, color: "#4cc9a0", weight: 1, fillOpacity: 0.12 }).addTo(map);
    }
    marker.setLatLng(ll); circle.setLatLng(ll); circle.setRadius(Math.max(3, S.sigma));
    trailPts.push(ll); if (trailPts.length > 2000) trailPts.shift(); trail.setLatLngs(trailPts);
    if (recenter) {
      const z = S.sigma > 3000 ? 12 : S.sigma > 400 ? 14 : S.sigma > 80 ? 16 : 18;
      map.setView(ll, Math.max(map.getZoom(), z));
    }
  }

  /* ---------------------------------------------------------------- stats */
  const fmtAcc = m => m >= 1000 ? "±" + (m / 1000).toFixed(1) + " km" : "±" + Math.round(m) + " m";
  function stats() {
    $("s-pos").textContent = S.has ? S.lat.toFixed(5) + ", " + S.lon.toFixed(5) : "ei vielä";
    $("s-acc").textContent = S.has ? fmtAcc(S.sigma) : "–";
    $("s-src").textContent = S.src || "–";
    $("s-steps").textContent = S.steps + (S.meters ? " (" + Math.round(S.meters) + " m)" : "");
    const th = trueHeading();
    $("s-head").textContent = th == null ? "ei kompassia" : Math.round(th) + "°";
    $("compass-label").textContent = th == null ? "ei suuntaa" : Math.round(th) + "°";
    $("compass-arrow").style.transform = "rotate(" + (th || 0) + "deg)";
    if (lastScan) $("s-scan").textContent = lastScan.wifi.length + " / " + lastScan.ble.length + " / " + lastScan.cells.length;
    $("s-msg").textContent = E.message() || "–";
    $("s-fp").textContent = E.counts().fingerprints;
  }
  function banner(text) { const b = $("banner"); b.hidden = !text; b.textContent = text || ""; }
  function checkStatus(st) {
    if (!st) return;
    $("s-dev").textContent = st.device + " · Android API " + st.sdk;
    const problems = [];
    if (!st.locationPermission) problems.push("Anna sovellukselle sijaintilupa (se tarvitaan Wi-Fi- ja mobiiliasemien lukemiseen; GPS:ää ei käytetä).");
    if (!st.locationServicesOn) problems.push("Laita puhelimen Sijainti-asetus päälle. Android estää muuten Wi-Fi- ja asematiedot kaikilta sovelluksilta. Sovellus ei käytä GPS-satelliitteja.");
    if (!st.wifiEnabled) problems.push("Laita Wi-Fi päälle (ei tarvitse olla yhdistettynä).");
    if (!st.hasTelephony) problems.push("Laitteessa ei ole matkapuhelinyhteyttä, solupaikannus ei käytössä.");
    banner(problems.join(" "));
  }

  /* ---------------------------------------------------------------- positioning */
  async function networkFix(reason) {
    if (busy) return;
    if (!E.available()) { banner("Radioskannaus toimii vain Android-sovelluksessa (ei selaimessa)."); log("Ei natiivipluginia, ei selainta varten"); return; }
    busy = true; $("btn-locate").disabled = true;
    try {
      log("Haku alkaa (" + reason + ")");
      const st = await E.prepare(); checkStatus(st);
      const sc = lastScan = await E.scan();
      log("Skannaus: " + sc.wifi.length + " Wi-Fi (" + (sc.wifiRaw || 0) + " raakana" + (sc.throttled ? ", Android rajoitti" : "") + "), " +
          sc.ble.length + " BLE, " + sc.cells.length + " solua" + (sc.errors.length ? " | virheet: " + sc.errors.join("; ") : ""));
      const fix = await E.locate(sc);
      if (!fix) { log("Ei sijaintia: " + E.message()); }
      else {
        const r = tracker.fuse(fix);
        log("Sijainti: " + fix.lat.toFixed(5) + ", " + fix.lon.toFixed(5) + " " + fmtAcc(fix.acc) + " (" + fix.src + ")");
        draw(r === "set");
      }
    } catch (e) { log("Virhe: " + errText(e)); }
    finally { busy = false; $("btn-locate").disabled = false; stats(); }
  }
  const errText = e => String((e && (e.message || e.errorMessage)) || e);

  async function learnHere() {
    if (!S.has) { log("Aseta ensin sijainti: paina karttaa tai Paikanna nyt"); return; }
    if (!E.available()) { log("Oppiminen toimii vain Android-sovelluksessa"); return; }
    if (S.sigma > 30 && !confirm("Sijainnin tarkkuus on vain " + fmtAcc(S.sigma) + ". Opittu paikka on yhtä väärä. Napauta ensin karttaa täsmälleen siihen kohtaan, jossa seisot. Tallennetaanko silti?")) return;
    const sc = (lastScan && Date.now() - lastScan.t < 20000) ? lastScan : (lastScan = await E.scan());
    const ok = E.learn(S.lat, S.lon, sc);
    log(ok ? "Paikka opittu (" + E.counts().fingerprints + " yhteensä)" : "Liian vähän signaaleja opittavaksi (tarvitaan vähintään 3)");
    stats();
  }

  /* ---------------------------------------------------------------- sensors and tracking */
  function onOrientation(ev) {
    if (ev.type === "deviceorientation" && absSeen) return;
    if (ev.type === "deviceorientationabsolute") absSeen = true;
    let h = null;
    if (typeof ev.webkitCompassHeading === "number") h = ev.webkitCompassHeading;
    else if (ev.alpha != null && ev.beta != null && ev.gamma != null && (ev.absolute || ev.type === "deviceorientationabsolute"))
      h = E.headingFromEuler(ev.alpha, ev.beta, ev.gamma);
    if (h == null) return;
    hv.s = hv.n ? 0.85 * hv.s + 0.15 * Math.sin(h * RAD) : Math.sin(h * RAD);
    hv.c = hv.n ? 0.85 * hv.c + 0.15 * Math.cos(h * RAD) : Math.cos(h * RAD);
    hv.n++;
    heading = E.norm360(Math.atan2(hv.s, hv.c) / RAD);
  }
  function onMotion(ev) {
    const a = ev.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    if (stepper.feed(performance.now(), a.x, a.y, a.z)) {
      const moved = tracker.step(trueHeading(), stepLen());
      if (moved) draw(false);
      stats();
    }
  }
  async function askMotionPermission() {      // only iOS-style WebViews have this
    try {
      if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === "function") await DeviceMotionEvent.requestPermission();
      if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === "function") await DeviceOrientationEvent.requestPermission();
    } catch (e) { log("Liikeanturilupa: " + errText(e)); }
  }
  async function startTracking() {
    await askMotionPermission();
    window.addEventListener("deviceorientationabsolute", onOrientation, true);
    window.addEventListener("deviceorientation", onOrientation, true);
    window.addEventListener("devicemotion", onMotion, true);
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { /* optional */ }
    tracking = true; $("btn-track").textContent = "Lopeta seuranta";
    log("Seuranta päällä: askeleet + kompassi, verkkopaikannus 30 s välein");
    networkFix("seuranta alkoi");
    netTimer = setInterval(() => networkFix("ajastettu"), 30000);
  }
  function stopTracking() {
    window.removeEventListener("deviceorientationabsolute", onOrientation, true);
    window.removeEventListener("deviceorientation", onOrientation, true);
    window.removeEventListener("devicemotion", onMotion, true);
    clearInterval(netTimer); try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignore */ }
    tracking = false; $("btn-track").textContent = "Aloita seuranta"; log("Seuranta pysäytetty");
  }

  /* ---------------------------------------------------------------- start */
  document.addEventListener("DOMContentLoaded", async () => {
    initMap();
    $("btn-locate").addEventListener("click", () => networkFix("käsin"));
    $("btn-track").addEventListener("click", () => (tracking ? stopTracking() : startTracking()));
    $("btn-learn").addEventListener("click", learnHere);
    $("btn-clear").addEventListener("click", () => { trailPts = []; if (trail) trail.setLatLngs([]); S.steps = 0; S.meters = 0; stats(); });
    $("btn-copylog").addEventListener("click", copyLog);
    setInterval(stats, 1500);
    log("Käynnistetty. Natiiviplugin: " + (E.available() ? "löytyi" : "ei (selain)"));
    if (E.available()) {
      try { checkStatus(await E.status()); } catch (e) { log("Tilan luku epäonnistui: " + errText(e)); }
    } else banner("Radioskannaus toimii vain Android-sovelluksessa. Selaimessa näet vain kartan.");
    stats();
  });
})();
