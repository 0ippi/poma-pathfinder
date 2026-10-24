(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const setText = (id, v) => { $(id).textContent = v; };
  const DEFAULT_VIEW = [61.4981, 23.7600];
  const M = 111320, RAD = Math.PI / 180;
  const STEP_THRESHOLD = 1.0, STEP_MIN_MS = 320, GPS_FRESH_MS = 12000;
  const wrap180 = d => ((d + 540) % 360) - 180;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
  };

  const state = {
    map: null, startMarker: null, posMarker: null, trail: null, errCircle: null,
    tracking: false, origin: null, pos: null, sigma: 0, track: [],
    heading: null, headingAbsolute: false, autoOffset: 0,
    stepScale: clamp(Number(store.get("poma.scale")) || 1, 0.7, 1.4),
    steps: 0, distance: 0, lastStepAt: 0, gravity: 9.81, smooth: 0, prevSmooth: 0,
    orientationHandler: null, orientationEvent: null, motionHandler: null, motionDetected: false,
    wakeLock: null, gpsWatch: null, gpsState: "Off", lastGpsAt: 0, calib: null,
    lastWirelessAt: 0, wlTimer: null, wlText: "Off", lastScan: null
  };

  const log = msg => {
    const el = $("log"), t = new Date().toLocaleTimeString("fi-FI");
    const old = el.textContent === "Event log…" ? "" : el.textContent;
    el.textContent = `${t} ${msg}\n${old}`.split("\n").slice(0, 40).join("\n");
  };

  const headingOffset = () => state.autoOffset + (Number($("heading-offset").value) || 0);
  const stepLength = () => {
    const h = Number($("height-cm").value);
    return (Number.isFinite(h) && h >= 100 && h <= 230 ? h : 175) / 100 * 0.415 * state.stepScale;
  };
  const gpsFresh = () => state.tracking && Date.now() - state.lastGpsAt < GPS_FRESH_MS;
  const wirelessFresh = () => state.tracking && Date.now() - state.lastWirelessAt < 90000;
  const W = () => window.PomaWireless;
  const useGps = () => $("source-mode").value === "auto";

  function hint() {
    if (!state.tracking) return "Press Start tracking.";
    if (!state.origin) {
      return useGps() && state.gpsState !== "Denied" && state.gpsState !== "Unavailable"
        ? "Looking for GPS, Wi-Fi or Bluetooth… or tap the map where you are."
        : W() && W().available() ? "Scanning Wi-Fi and Bluetooth… or tap the map where you are."
        : "No start point. Wi-Fi/Bluetooth need the Android app. Tap the map where you are, then walk.";
    }
    if (state.heading === null) return "Waiting for compass. Move the phone in a figure-8 to calibrate.";
    if ($("carry-mode").value === "pocket") return "Pocket mode: steps are counted, position is not moved.";
    if (gpsFresh()) return "GPS fix in use. Steps fill in when GPS drops out.";
    if (wirelessFresh()) return "Position from nearby Wi-Fi/Bluetooth. Steps fill in between scans.";
    if (!state.headingAbsolute) return "Compass is relative here, so direction may be off. Use a GPS fix or the manual heading slider.";
    return `Tracking with steps and compass. Error grows about 5 % of distance walked.`;
  }

  function updateStats() {
    const hasH = state.heading !== null;
    const src = !state.origin ? (state.tracking ? "Waiting for start" : "Not started")
      : gpsFresh() ? "GPS + steps" : wirelessFresh() ? "Wi-Fi/BT + steps" : "Steps + compass";
    setText("position-status", src);
    setText("accuracy-value", state.origin ? `~${Math.round(state.sigma)} m` : "Unknown");
    setText("heading-value", hasH ? `${Math.round((state.heading + headingOffset() + 360) % 360)}°` : "Unknown");
    setText("steps-value", String(state.steps));
    setText("distance-value", `${state.distance.toFixed(1)} m`);
    setText("pos-value", state.pos ? `${state.pos.lat.toFixed(5)}, ${state.pos.lon.toFixed(5)}` : "–");
    setText("gps-status", state.gpsState);
    setText("wireless-status", W() && W().available() ? state.wlText : "Needs Android app");
    setText("compass-status", !state.orientationHandler ? "Inactive" : !hasH ? "Waiting" :
      state.headingAbsolute ? "Active (absolute)" : "Active (relative)");
    setText("motion-status", state.motionHandler ? (state.motionDetected ? "Receiving events" : "Waiting") : "Inactive");
    setText("wake-status", state.wakeLock ? "On" : "Off");
    setText("scale-status", state.stepScale.toFixed(2));
    setText("assistant-message", hint());
    $("compass-arrow").style.transform = hasH ? `rotate(${state.heading + headingOffset()}deg)` : "none";
    setText("compass-label", hasH ? `${Math.round((state.heading + headingOffset() + 360) % 360)}°` : "No heading");
    const b = $("toggle-tracking");
    b.textContent = state.tracking ? "Stop tracking" : "Start tracking";
    b.classList.toggle("stop", state.tracking);
    b.classList.toggle("primary", !state.tracking);
  }

  function initMap() {
    if (!window.L) { setText("map-note", "Map library unavailable. Check your internet connection."); return; }
    state.map = L.map("map").setView(DEFAULT_VIEW, 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(state.map);
    state.map.on("click", e => setOriginAt(e.latlng.lat, e.latlng.lng, 8, "map"));
  }

  function drawPosition() {
    if (!state.map || !state.pos) return;
    const ll = [state.pos.lat, state.pos.lon];
    if (!state.posMarker) {
      state.posMarker = L.circleMarker(ll, { radius: 7, color: "#67e0bd", fillColor: "#67e0bd", fillOpacity: 1 }).addTo(state.map);
      state.errCircle = L.circle(ll, { radius: state.sigma, color: "#67e0bd", weight: 1, fillOpacity: 0.12 }).addTo(state.map);
      state.trail = L.polyline([ll], { color: "#1b8f72", weight: 3 }).addTo(state.map);
    } else {
      state.posMarker.setLatLng(ll);
      state.errCircle.setLatLng(ll).setRadius(state.sigma);
      state.trail.addLatLng(ll);
    }
    if (!state.map.getBounds().contains(ll)) state.map.panTo(ll);
  }
  function clearOverlays() {
    for (const k of ["posMarker", "errCircle", "trail"]) if (state[k]) { state[k].remove(); state[k] = null; }
  }

  function setOriginAt(lat, lon, sigma, via) {
    state.origin = { lat, lon };
    state.pos = { lat, lon };
    state.sigma = sigma;
    state.steps = 0; state.distance = 0; state.calib = null;
    state.track = [{ t: Date.now(), lat, lon, step: 0, src: via }];
    clearOverlays(); drawPosition();
    store.set("poma.origin", JSON.stringify(state.origin));
    $("start-lat").value = lat.toFixed(6); $("start-lon").value = lon.toFixed(6);
    if (state.map) {
      if (!state.startMarker) state.startMarker = L.marker([lat, lon]).addTo(state.map);
      else state.startMarker.setLatLng([lat, lon]);
      state.map.setView([lat, lon], 18);
    }
    log(`Start set via ${via}: ${lat.toFixed(5)}, ${lon.toFixed(5)} (±${Math.round(sigma)} m)`);
    updateStats();
  }

  function setOriginFromInputs() {
    const lat = Number($("start-lat").value), lon = Number($("start-lon").value);
    if (!$("start-lat").value || !$("start-lon").value || !Number.isFinite(lat) || !Number.isFinite(lon) ||
        Math.abs(lat) > 90 || Math.abs(lon) > 180) { setText("assistant-message", "Enter valid coordinates, or tap the map."); return; }
    setOriginAt(lat, lon, 10, "coordinates");
  }

  /* ---------- Steps ---------- */
  function moveMeters(dN, dE) {
    state.pos.lat += dN / M;
    state.pos.lon += dE / (M * Math.cos(state.pos.lat * RAD));
  }

  function onStep(now) {
    state.steps++; state.lastStepAt = now;
    const len = stepLength();
    state.distance += len;
    if (!state.pos || state.heading === null || $("carry-mode").value === "pocket") { updateStats(); return; }
    const h = (((state.heading + headingOffset()) % 360) + 360) % 360 * RAD;
    moveMeters(len * Math.cos(h), len * Math.sin(h));
    state.sigma += len * 0.05;
    state.track.push({ t: Date.now(), lat: state.pos.lat, lon: state.pos.lon, step: state.steps, src: "pdr" });
    drawPosition();
  }

  function startMotion() {
    stopMotion();
    state.motionHandler = e => {
      const a = e.accelerationIncludingGravity;
      if (!a || typeof a.x !== "number") return;
      state.motionDetected = true;
      const mag = Math.hypot(a.x, a.y, a.z || 0);
      state.gravity = state.gravity * 0.98 + mag * 0.02;
      state.prevSmooth = state.smooth;
      state.smooth = state.smooth * 0.6 + (mag - state.gravity) * 0.4;
      const now = performance.now();
      if (state.prevSmooth < STEP_THRESHOLD && state.smooth >= STEP_THRESHOLD && now - state.lastStepAt > STEP_MIN_MS) {
        onStep(now); updateStats();
      }
    };
    window.addEventListener("devicemotion", state.motionHandler, true);
  }
  function stopMotion() {
    if (state.motionHandler) window.removeEventListener("devicemotion", state.motionHandler, true);
    state.motionHandler = null;
  }

  /* ---------- Compass ---------- */
  function tiltHeading(alpha, beta, gamma) {
    const x = beta * RAD, y = gamma * RAD, z = alpha * RAD;
    const vx = -Math.cos(z) * Math.sin(y) - Math.sin(z) * Math.sin(x) * Math.cos(y);
    const vy = -Math.sin(z) * Math.sin(y) + Math.cos(z) * Math.sin(x) * Math.cos(y);
    return (Math.atan2(vx, vy) / RAD + 360) % 360;
  }
  function startCompass() {
    stopCompass();
    const hasAbs = "ondeviceorientationabsolute" in window;
    state.orientationEvent = hasAbs ? "deviceorientationabsolute" : "deviceorientation";
    state.orientationHandler = e => {
      let h = null, abs = false;
      if (typeof e.webkitCompassHeading === "number") { h = e.webkitCompassHeading; abs = true; }
      else if ([e.alpha, e.beta, e.gamma].every(v => typeof v === "number")) {
        h = tiltHeading(e.alpha, e.beta, e.gamma); abs = hasAbs || e.absolute === true;
      }
      if (h === null || !Number.isFinite(h)) return;
      state.headingAbsolute = abs;
      if (state.heading === null) state.heading = h;
      else {
        const k = 0.2, s = Math.sin(state.heading * RAD) * (1 - k) + Math.sin(h * RAD) * k;
        const c = Math.cos(state.heading * RAD) * (1 - k) + Math.cos(h * RAD) * k;
        state.heading = (Math.atan2(s, c) / RAD + 360) % 360;
      }
      updateStats();
    };
    window.addEventListener(state.orientationEvent, state.orientationHandler, true);
  }
  function stopCompass() {
    if (state.orientationHandler) window.removeEventListener(state.orientationEvent, state.orientationHandler, true);
    state.orientationHandler = null;
  }

  /* ---------- GPS (optional) ---------- */
  function onGps(p) {
    const { latitude: lat, longitude: lon, accuracy: acc, heading: gh, speed } = p.coords;
    state.gpsState = `Fix ±${Math.round(acc)} m`;
    if (acc > 60 && state.origin) { state.gpsState = `Weak ±${Math.round(acc)} m (ignored)`; updateStats(); return; }
    state.lastGpsAt = Date.now();
    if (!state.origin) { setOriginAt(lat, lon, acc, "gps"); return; }

    if (acc <= 20) {
      // auto step-length calibration against GPS distance
      if (!state.calib) state.calib = { lat, lon, d: state.distance };
      else {
        const gpsD = Math.hypot((lat - state.calib.lat) * M, (lon - state.calib.lon) * M * Math.cos(lat * RAD));
        const pdrD = state.distance - state.calib.d;
        if (gpsD > 30 && pdrD > 30) {
          const ratio = clamp(gpsD / pdrD, 0.6, 1.6);
          state.stepScale = clamp(state.stepScale * (0.8 + 0.2 * ratio), 0.7, 1.4);
          store.set("poma.scale", String(state.stepScale));
          log(`Step scale → ${state.stepScale.toFixed(2)}`);
          state.calib = { lat, lon, d: state.distance };
        }
      }
      // auto heading calibration from GPS course while walking
      if (typeof gh === "number" && Number.isFinite(gh) && speed >= 1 && state.heading !== null &&
          $("carry-mode").value === "hand") {
        const err = wrap180(gh - state.heading - state.autoOffset);
        state.autoOffset = wrap180(state.autoOffset + 0.15 * err);
      }
    }
    fuse(lat, lon, acc, "gps");
    updateStats();
  }
  /* Combine any absolute fix (GPS, Wi-Fi, BLE) with the current estimate, weighted by variance */
  function fuse(lat, lon, acc, src) {
    const s2 = state.sigma ** 2, a2 = acc ** 2, K = s2 / (s2 + a2);
    state.pos.lat += K * (lat - state.pos.lat);
    state.pos.lon += K * (lon - state.pos.lon);
    state.sigma = Math.max(3, Math.sqrt(1 / (1 / s2 + 1 / a2)));
    state.track.push({ t: Date.now(), lat: state.pos.lat, lon: state.pos.lon, step: state.steps, src });
    drawPosition();
  }

  /* ---------- Wi-Fi + Bluetooth (native Android app only) ---------- */
  async function wirelessStep() {
    if (!state.tracking) return;
    try {
      const sc = await W().scan();
      state.lastScan = sc;
      let t = `${sc.wifi.length} Wi-Fi, ${sc.ble.length} BLE${sc.throttled ? " (throttled)" : ""}`;
      if (sc.errors.length) t += ` · ${sc.errors.join(", ")}`;
      const fix = await W().locate(sc);
      if (fix) {
        state.lastWirelessAt = Date.now();
        t += ` · ${fix.src} ±${Math.round(fix.acc)} m`;
        if (!state.origin) setOriginAt(fix.lat, fix.lon, fix.acc, fix.src);
        else fuse(fix.lat, fix.lon, fix.acc, fix.src);
      } else t += " · no position match";
      state.wlText = t;
    } catch (e) { state.wlText = "Scan failed: " + (e && e.message || e); }
    updateStats();
    if (state.tracking) state.wlTimer = setTimeout(wirelessStep, 30000);
  }
  async function startWireless() {
    try {
      const st = await W().prepare();
      if (!st.wifiPermission && !st.blePermission) { state.wlText = "Permission denied"; return; }
      if (!st.locationServicesOn) log("Android location switch is off: Wi-Fi/BLE scans will return nothing. GPS is not needed, but this switch is.");
      if (!st.wifiEnabled) log("Wi-Fi is off");
      if (!st.bluetoothEnabled) log("Bluetooth is off");
      state.wlText = "Scanning…";
      wirelessStep();
    } catch (e) { state.wlText = "Unavailable: " + (e && e.message || e); }
  }
  function stopWireless() { clearTimeout(state.wlTimer); state.wlTimer = null; state.wlText = "Off"; }

  async function learnHere() {
    if (!W() || !W().available()) { setText("assistant-message", "Learning places needs the Android app."); return; }
    if (!state.pos || state.sigma > 10) { setText("assistant-message", "Tap the map exactly where you stand first (position error must be under 10 m)."); return; }
    const sc = await W().scan();
    setText("assistant-message", W().learn(state.pos.lat, state.pos.lon, sc)
      ? `Saved fingerprint (${W().counts().fingerprints} total).` : "Too few Wi-Fi/BLE signals here to save.");
  }
  function exportDb() {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(W().exportDb(), null, 2)], { type: "application/json" }));
    a.download = "poma-wireless-db.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function onGpsError(err) {
    if (err.code === 1) { state.gpsState = "Denied"; stopGps(false); log("GPS permission denied; continuing without GPS"); }
    else state.gpsState = err.code === 2 ? "No signal" : "Timeout";
    updateStats();
  }
  function startGps() {
    if (state.gpsWatch !== null) return;
    if (!navigator.geolocation) { state.gpsState = "Unavailable"; return; }
    state.gpsState = "Searching…";
    state.gpsWatch = navigator.geolocation.watchPosition(onGps, onGpsError,
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }
  function stopGps(reset = true) {
    if (state.gpsWatch !== null) navigator.geolocation.clearWatch(state.gpsWatch);
    state.gpsWatch = null;
    if (reset) state.gpsState = "Off";
  }

  /* ---------- Wake lock ---------- */
  async function requestWake() {
    try {
      if ("wakeLock" in navigator) {
        state.wakeLock = await navigator.wakeLock.request("screen");
        state.wakeLock.addEventListener("release", () => { state.wakeLock = null; updateStats(); });
      }
    } catch (err) { log(`Wake lock failed: ${err.name}`); }
  }
  function releaseWake() { if (state.wakeLock) state.wakeLock.release().catch(() => {}); state.wakeLock = null; }

  /* ---------- Start / stop ---------- */
  async function startTracking() {
    state.tracking = true;
    // Ask for everything in the same user gesture (iOS needs this)
    const ask = (C) => C && typeof C.requestPermission === "function" ? C.requestPermission() : Promise.resolve("granted");
    const pO = ask(window.DeviceOrientationEvent), pM = ask(window.DeviceMotionEvent);
    if (useGps()) startGps();
    const [o, m] = await Promise.allSettled([pO, pM]);
    if (typeof DeviceOrientationEvent !== "undefined" && o.status === "fulfilled" && o.value === "granted") startCompass();
    else log("Compass unavailable or denied");
    if (typeof DeviceMotionEvent !== "undefined" && m.status === "fulfilled" && m.value === "granted") startMotion();
    else log("Motion sensors unavailable or denied");
    if (!window.isSecureContext) log("Not HTTPS: sensors may be blocked");
    await requestWake();
    if (W() && W().available()) startWireless();
    updateStats();
  }
  function stopTracking() {
    state.tracking = false;
    stopCompass(); stopMotion(); stopGps(); stopWireless(); releaseWake();
    state.heading = null; state.motionDetected = false; state.smooth = state.prevSmooth = 0;
    updateStats();
  }

  function exportTrack() {
    if (!state.track.length) { setText("assistant-message", "Nothing to export yet."); return; }
    const data = { exported: new Date().toISOString(), origin: state.origin, steps: state.steps,
      distance_m: Number(state.distance.toFixed(1)), step_scale: state.stepScale, track: state.track };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = `poma-track-${Date.now()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  document.addEventListener("DOMContentLoaded", () => {
    initMap();
    const h = store.get("poma.height"); if (h) $("height-cm").value = h;
    const mode = store.get("poma.mode"); if (mode) $("source-mode").value = mode;

    $("toggle-tracking").addEventListener("click", () => state.tracking ? stopTracking() : startTracking());
    $("source-mode").addEventListener("change", () => {
      store.set("poma.mode", $("source-mode").value);
      if (state.tracking) { useGps() ? startGps() : stopGps(); }
      updateStats();
    });
    $("set-origin").addEventListener("click", setOriginFromInputs);
    $("height-cm").addEventListener("change", () => store.set("poma.height", $("height-cm").value));
    $("carry-mode").addEventListener("change", updateStats);
    $("heading-offset").addEventListener("input", () => { setText("offset-label", `${$("heading-offset").value}°`); updateStats(); });
    $("export-track").addEventListener("click", exportTrack);
    $("learn-here").addEventListener("click", learnHere);
    $("export-db").addEventListener("click", () => W() && exportDb());
    $("import-db").addEventListener("change", async e => {
      try { W().importDb(JSON.parse(await e.target.files[0].text())); setText("assistant-message", "Imported wireless database."); }
      catch { setText("assistant-message", "Could not read that file."); }
      e.target.value = "";
    });
    $("reset-calibration").addEventListener("click", () => {
      state.stepScale = 1; state.autoOffset = 0; store.set("poma.scale", "1"); log("Calibration reset"); updateStats();
    });
    $("reset-estimate").addEventListener("click", () => {
      if (state.origin) setOriginAt(state.origin.lat, state.origin.lon, 5, "reset");
    });
    $("clear-trail").addEventListener("click", () => {
      if (state.trail) state.trail.setLatLngs(state.pos ? [[state.pos.lat, state.pos.lon]] : []);
      state.track = [];
    });
    $("center-map").addEventListener("click", () => {
      if (!state.map) return;
      const p = state.pos || state.origin;
      state.map.setView(p ? [p.lat, p.lon] : DEFAULT_VIEW, p ? 18 : 12);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && state.tracking && !state.wakeLock) requestWake().then(updateStats);
    });
    setInterval(() => { if (state.tracking) updateStats(); }, 3000);
    updateStats();
  });
})();
