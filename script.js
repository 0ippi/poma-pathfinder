(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const setText = (id, v) => { $(id).textContent = v; };
  const DEFAULT_VIEW = [61.4981, 23.7600];
  const M_PER_DEG = 111320;
  const STEP_THRESHOLD = 1.0;   // m/s² above gravity
  const STEP_MIN_MS = 320;      // refractory period between steps

  const state = {
    map: null, startMarker: null, posMarker: null, trail: null, errCircle: null,
    origin: null, pos: null, track: [],
    heading: null, headingAbsolute: false,
    steps: 0, distance: 0, lastStepAt: 0,
    gravity: 9.81, smooth: 0, prevSmooth: 0,
    orientationHandler: null, orientationEvent: null, motionHandler: null,
    motionDetected: false, wakeLock: null
  };

  const log = msg => {
    const el = $("log");
    const t = new Date().toLocaleTimeString("fi-FI");
    el.textContent = `${t} ${msg}\n` + (el.textContent === "Event log…" ? "" : el.textContent);
    el.textContent = el.textContent.split("\n").slice(0, 40).join("\n");
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
  };

  const headingOffset = () => Number($("heading-offset").value) || 0;
  const stepLength = () => {
    const h = Number($("height-cm").value);
    return (Number.isFinite(h) && h >= 100 && h <= 230 ? h : 175) / 100 * 0.415;
  };
  const uncertainty = () => 2 + state.distance * 0.05; // rough: ~5 % of path + 2 m

  function updateStats() {
    const hasH = state.heading !== null;
    setText("heading-value", hasH ? `${Math.round(state.heading)}°` : "Unknown");
    setText("position-status", state.origin ? "Tracking from reference" : "No reference point");
    setText("accuracy-value", state.origin ? `~${Math.round(uncertainty())} m (estimate)` : "Unknown");
    setText("compass-status",
      !state.orientationHandler ? "Inactive" :
      !hasH ? "Waiting" :
      state.headingAbsolute ? "Active (absolute)" : "Active (relative, unreliable)");
    setText("motion-status", state.motionHandler ? (state.motionDetected ? "Receiving events" : "Waiting") : "Inactive");
    setText("motion-value", state.motionDetected ? "Sensor active" : "Not detected");
    setText("steps-value", String(state.steps));
    setText("distance-value", `${state.distance.toFixed(1)} m`);
    setText("pos-value", state.pos ? `${state.pos.lat.toFixed(6)}, ${state.pos.lon.toFixed(6)}` : "–");
    setText("wake-status", state.wakeLock ? "On" : "Off");
    $("compass-arrow").style.transform = hasH ? `rotate(${state.heading + headingOffset()}deg)` : "none";
    setText("compass-label", hasH ? `${Math.round((state.heading + headingOffset() + 360) % 360)}°` : "No heading");
  }

  function initMap() {
    if (!window.L) { setText("map-note", "Map library unavailable. Check your internet connection."); return; }
    state.map = L.map("map").setView(DEFAULT_VIEW, 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(state.map);
    state.map.on("click", e => {
      $("start-lat").value = e.latlng.lat.toFixed(6);
      $("start-lon").value = e.latlng.lng.toFixed(6);
      setOrigin();
    });
  }

  function drawPosition() {
    if (!state.map || !state.pos) return;
    const ll = [state.pos.lat, state.pos.lon];
    if (!state.posMarker) {
      state.posMarker = L.circleMarker(ll, { radius: 7, color: "#67e0bd", fillColor: "#67e0bd", fillOpacity: 1 }).addTo(state.map);
      state.errCircle = L.circle(ll, { radius: uncertainty(), color: "#67e0bd", weight: 1, fillOpacity: 0.12 }).addTo(state.map);
      state.trail = L.polyline([ll], { color: "#1b8f72", weight: 3 }).addTo(state.map);
    } else {
      state.posMarker.setLatLng(ll);
      state.errCircle.setLatLng(ll).setRadius(uncertainty());
      state.trail.addLatLng(ll);
    }
    if (!state.map.getBounds().contains(ll)) state.map.panTo(ll);
  }

  function clearOverlays() {
    for (const k of ["posMarker", "errCircle", "trail"]) {
      if (state[k]) { state[k].remove(); state[k] = null; }
    }
  }

  function resetTracking() {
    state.steps = 0; state.distance = 0; state.track = [];
    state.pos = state.origin ? { ...state.origin } : null;
    clearOverlays();
    if (state.pos) { state.track.push({ t: Date.now(), lat: state.pos.lat, lon: state.pos.lon, step: 0 }); drawPosition(); }
  }

  function setOrigin() {
    const latS = $("start-lat").value.trim(), lonS = $("start-lon").value.trim();
    const lat = Number(latS), lon = Number(lonS);
    if (!latS || !lonS || !Number.isFinite(lat) || !Number.isFinite(lon) ||
        lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      setText("assistant-message", "Enter valid coordinates, or tap the map to choose a starting point.");
      return;
    }
    state.origin = { lat, lon };
    store.set("poma.origin", JSON.stringify(state.origin));
    resetTracking();
    if (state.map) {
      if (!state.startMarker) state.startMarker = L.marker([lat, lon]).addTo(state.map);
      else state.startMarker.setLatLng([lat, lon]);
      state.map.setView([lat, lon], 18);
    }
    setText("map-note", "Pin = your entered start. Green dot = dead-reckoning estimate with error circle. Not a GPS fix.");
    setText("assistant-message", state.orientationHandler
      ? "Start saved. Hold the phone flat-ish and walk."
      : "Start saved. Now enable sensors and start walking.");
    updateStats();
  }

  /* ---------- Pedestrian dead reckoning ---------- */
  function onStep(now) {
    state.steps++;
    state.lastStepAt = now;
    const len = stepLength();
    state.distance += len;
    setText("last-step", `${len.toFixed(2)} m`);
    $("steps-value").classList.remove("pulse");
    void $("steps-value").offsetWidth;
    $("steps-value").classList.add("pulse");

    if (!state.origin || !state.pos) return;
    if ($("carry-mode").value === "pocket") {
      setText("assistant-message", "Pocket mode: steps are counted but the position is not moved, because heading from a pocketed phone is unreliable.");
      return;
    }
    if (state.heading === null) {
      setText("assistant-message", "Steps detected but no heading yet. Move the phone in a figure-8 to calibrate the compass.");
      return;
    }
    const h = ((state.heading + headingOffset()) % 360 + 360) % 360 * Math.PI / 180;
    const dN = len * Math.cos(h), dE = len * Math.sin(h);
    state.pos.lat += dN / M_PER_DEG;
    state.pos.lon += dE / (M_PER_DEG * Math.cos(state.pos.lat * Math.PI / 180));
    state.track.push({ t: Date.now(), lat: state.pos.lat, lon: state.pos.lon, step: state.steps, heading: Math.round(h * 180 / Math.PI) });
    drawPosition();
    setText("assistant-message", state.headingAbsolute
      ? `Tracking. Error grows roughly 5 % of distance; currently ~${Math.round(uncertainty())} m.`
      : "Heading is relative (no magnetic north). Position will drift in the wrong direction; use the heading correction slider.");
  }

  function startMotion() {
    stopMotion();
    state.motionHandler = e => {
      const a = e.accelerationIncludingGravity;
      if (!a || typeof a.x !== "number") return;
      state.motionDetected = true;
      const mag = Math.hypot(a.x, a.y, a.z || 0);
      state.gravity = state.gravity * 0.98 + mag * 0.02;      // slow gravity estimate
      const dyn = mag - state.gravity;
      state.prevSmooth = state.smooth;
      state.smooth = state.smooth * 0.6 + dyn * 0.4;           // low-pass
      const now = performance.now();
      if (state.prevSmooth < STEP_THRESHOLD && state.smooth >= STEP_THRESHOLD &&
          now - state.lastStepAt > STEP_MIN_MS) {
        onStep(now);
      }
      updateStats();
    };
    window.addEventListener("devicemotion", state.motionHandler, true);
  }
  function stopMotion() {
    if (state.motionHandler) window.removeEventListener("devicemotion", state.motionHandler, true);
    state.motionHandler = null;
  }

  /* ---------- Compass ---------- */
  function tiltCompensatedHeading(alpha, beta, gamma) {
    const d = Math.PI / 180;
    const x = beta * d, y = gamma * d, z = alpha * d;
    const cY = Math.cos(y), sY = Math.sin(y), sX = Math.sin(x), cZ = Math.cos(z), sZ = Math.sin(z);
    const vx = -cZ * sY - sZ * sX * cY;
    const vy = -sZ * sY + cZ * sX * cY;
    let h = Math.atan2(vx, vy) / d;
    return (h + 360) % 360;
  }

  function startCompass() {
    stopCompass();
    const hasAbs = "ondeviceorientationabsolute" in window;
    state.orientationEvent = hasAbs ? "deviceorientationabsolute" : "deviceorientation";
    state.orientationHandler = e => {
      let h = null, abs = false;
      if (typeof e.webkitCompassHeading === "number") { h = e.webkitCompassHeading; abs = true; }
      else if (typeof e.alpha === "number" && typeof e.beta === "number" && typeof e.gamma === "number") {
        h = tiltCompensatedHeading(e.alpha, e.beta, e.gamma);
        abs = hasAbs || e.absolute === true;
      }
      if (h === null || !Number.isFinite(h)) return;
      state.headingAbsolute = abs;
      if (state.heading === null) state.heading = h;
      else { // circular low-pass
        const r = Math.PI / 180, k = 0.2;
        const s = Math.sin(state.heading * r) * (1 - k) + Math.sin(h * r) * k;
        const c = Math.cos(state.heading * r) * (1 - k) + Math.cos(h * r) * k;
        state.heading = (Math.atan2(s, c) / r + 360) % 360;
      }
      updateStats();
    };
    window.addEventListener(state.orientationEvent, state.orientationHandler, true);
    log(`Compass listening via ${state.orientationEvent}`);
  }
  function stopCompass() {
    if (state.orientationHandler) window.removeEventListener(state.orientationEvent, state.orientationHandler, true);
    state.orientationHandler = null;
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

  /* ---------- Sensor control ---------- */
  async function enableSensors() {
    if (!window.isSecureContext) {
      setText("sensor-status", "Sensors need HTTPS. Open the GitHub Pages https:// address.");
      return;
    }
    const msgs = [];
    // Request both permissions synchronously (iOS requires the user gesture)
    const askO = typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function"
      ? DeviceOrientationEvent.requestPermission() : Promise.resolve("granted");
    const askM = typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function"
      ? DeviceMotionEvent.requestPermission() : Promise.resolve("granted");
    const [o, m] = await Promise.allSettled([askO, askM]);

    if (typeof DeviceOrientationEvent === "undefined") msgs.push("Compass unavailable");
    else if (o.status === "fulfilled" && o.value === "granted") startCompass();
    else msgs.push("Compass permission denied");

    if (typeof DeviceMotionEvent === "undefined") msgs.push("Motion sensors unavailable");
    else if (m.status === "fulfilled" && m.value === "granted") startMotion();
    else msgs.push("Motion permission denied");

    await requestWake();
    setText("sensor-status", msgs.length ? msgs.join(". ") + "." :
      "Sensors running. If nothing updates in a few seconds, check browser site permissions for motion sensors.");
    log(msgs.length ? msgs.join("; ") : "Sensors started");
    updateStats();
  }

  function stopSensors() {
    stopCompass(); stopMotion(); releaseWake();
    state.heading = null; state.motionDetected = false; state.smooth = state.prevSmooth = 0;
    setText("sensor-status", "Sensor listening stopped.");
    log("Sensors stopped");
    updateStats();
  }

  function exportTrack() {
    if (!state.track.length) { setText("assistant-message", "Nothing to export yet."); return; }
    const data = { exported: new Date().toISOString(), origin: state.origin, steps: state.steps,
      distance_m: Number(state.distance.toFixed(1)), step_length_m: Number(stepLength().toFixed(3)),
      heading_correction_deg: headingOffset(), track: state.track };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = `poma-track-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function explainPositioning() {
    setText("assistant-message",
      "This app uses dead reckoning: a known start, counted steps and compass heading. A compass gives direction, not location, and errors accumulate (about 5 % of distance, worse near metal or indoors). Wi-Fi and Bluetooth positioning need native Android access and reference data, and are not implemented.");
  }

  document.addEventListener("DOMContentLoaded", () => {
    initMap();

    const saved = store.get("poma.origin");
    if (saved) {
      try {
        const o = JSON.parse(saved);
        $("start-lat").value = o.lat; $("start-lon").value = o.lon;
      } catch { /* ignore */ }
    }
    const h = store.get("poma.height");
    if (h) $("height-cm").value = h;

    $("set-origin").addEventListener("click", setOrigin);
    $("enable-sensors").addEventListener("click", enableSensors);
    $("stop-sensors").addEventListener("click", stopSensors);
    $("explain-positioning").addEventListener("click", explainPositioning);
    $("export-track").addEventListener("click", exportTrack);
    $("height-cm").addEventListener("change", () => store.set("poma.height", $("height-cm").value));
    $("heading-offset").addEventListener("input", () => {
      setText("offset-label", `${$("heading-offset").value}°`);
      updateStats();
    });
    $("reset-estimate").addEventListener("click", () => {
      if (!state.origin) { setText("assistant-message", "Set a starting point first."); return; }
      resetTracking();
      if (state.map) state.map.setView([state.origin.lat, state.origin.lon], 18);
      setText("assistant-message", "Position reset to the starting point.");
      updateStats();
    });
    $("clear-trail").addEventListener("click", () => {
      if (state.trail) state.trail.setLatLngs(state.pos ? [[state.pos.lat, state.pos.lon]] : []);
      state.track = state.pos ? [{ t: Date.now(), lat: state.pos.lat, lon: state.pos.lon, step: state.steps }] : [];
    });
    $("center-map").addEventListener("click", () => {
      if (!state.map) return;
      const p = state.pos || state.origin;
      state.map.setView(p ? [p.lat, p.lon] : DEFAULT_VIEW, p ? 18 : 12);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && state.motionHandler && !state.wakeLock) requestWake().then(updateStats);
    });

    updateStats();
  });
})();
