
(() => {
  "use strict";

  const $ = id => document.getElementById(id);

  const state = {
    map: null,
    marker: null,
    origin: null,
    heading: null,
    orientationHandler: null,
    motionHandler: null,
    motionDetected: false
  };

  function setText(id, value) {
    $(id).textContent = value;
  }

  function updateStats() {
    setText(
      "heading-value",
      state.heading === null
        ? "Unknown"
        : `${Math.round(state.heading)}°`
    );

    setText(
      "position-status",
      state.origin ? "Reference point set" : "No reference point"
    );

    setText(
      "accuracy-value",
      state.origin ? "Not verified" : "Unknown"
    );

    setText(
      "compass-status",
      state.heading === null ? "No heading" : "Active"
    );

    setText(
      "motion-status",
      state.motionDetected ? "Sensor events received" : "Waiting"
    );

    setText(
      "motion-value",
      state.motionDetected ? "Movement sensor active" : "Not detected"
    );

    if (state.heading !== null) {
      $("compass-arrow").style.transform =
        `rotate(${state.heading}deg)`;

      setText("compass-label", `${Math.round(state.heading)}°`);
    }
  }

  function initMap() {
    if (!window.L) {
      setText(
        "map-note",
        "Map library unavailable. Check your internet connection."
      );
      return;
    }

    state.map = L.map("map").setView([61.4981, 23.7600], 12);

    L.tileLayer(
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        maxZoom: 19,
        attribution: "© OpenStreetMap"
      }
    ).addTo(state.map);
  }

  function setOrigin() {
    const latInput = $("start-lat").value.trim();
    const lonInput = $("start-lon").value.trim();
    const lat = Number(latInput);
    const lon = Number(lonInput);

    if (
      !latInput ||
      !lonInput ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -90 || lat > 90 ||
      lon < -180 || lon > 180
    ) {
      setText(
        "assistant-message",
        "Enter valid coordinates for a known starting point."
      );
      return;
    }

    state.origin = { lat, lon };

    if (state.map) {
      const coords = [lat, lon];

      if (!state.marker) {
        state.marker = L.marker(coords).addTo(state.map);
      } else {
        state.marker.setLatLng(coords);
      }

      state.map.setView(coords, 16);
    }

    setText(
      "map-note",
      "The marker shows the manually entered starting point, not a live position."
    );

    setText(
      "assistant-message",
      "Starting point saved. Sensor-based movement tracking is not yet implemented."
    );

    updateStats();
  }

  function startCompass() {
    if (state.orientationHandler) {
      window.removeEventListener(
        "deviceorientation",
        state.orientationHandler,
        true
      );
    }

    state.orientationHandler = event => {
      let heading = null;

      if (typeof event.webkitCompassHeading === "number") {
        heading = event.webkitCompassHeading;
      } else if (typeof event.alpha === "number") {
        heading = 360 - event.alpha;
      }

      if (heading !== null && Number.isFinite(heading)) {
        state.heading = ((heading % 360) + 360) % 360;
        updateStats();
      }
    };

    window.addEventListener(
      "deviceorientation",
      state.orientationHandler,
      true
    );
  }

  function startMotion() {
    if (state.motionHandler) {
      window.removeEventListener(
        "devicemotion",
        state.motionHandler,
        true
      );
    }

    state.motionHandler = event => {
      const acceleration = event.accelerationIncludingGravity;

      if (
        acceleration &&
        [acceleration.x, acceleration.y, acceleration.z]
          .some(value => typeof value === "number")
      ) {
        state.motionDetected = true;
        updateStats();
      }
    };

    window.addEventListener(
      "devicemotion",
      state.motionHandler,
      true
    );
  }

  async function enableSensors() {
    const messages = [];

    try {
      if (
        typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function"
      ) {
        const result =
          await DeviceOrientationEvent.requestPermission();

        if (result === "granted") {
          startCompass();
        } else {
          messages.push("Compass permission denied");
        }
      } else if (typeof DeviceOrientationEvent !== "undefined") {
        startCompass();
      } else {
        messages.push("Compass sensor unavailable");
      }
    } catch {
      messages.push("Could not start compass");
    }

    try {
      if (
        typeof DeviceMotionEvent !== "undefined" &&
        typeof DeviceMotionEvent.requestPermission === "function"
      ) {
        const result = await DeviceMotionEvent.requestPermission();

        if (result === "granted") {
          startMotion();
        } else {
          messages.push("Motion permission denied");
        }
      } else if (typeof DeviceMotionEvent !== "undefined") {
        startMotion();
      } else {
        messages.push("Motion sensors unavailable");
      }
    } catch {
      messages.push("Could not start motion sensors");
    }

    setText(
      "sensor-status",
      messages.length
        ? messages.join(". ")
        : "Sensor startup requested. Check the statuses below."
    );

    updateStats();
  }

  function stopSensors() {
    if (state.orientationHandler) {
      window.removeEventListener(
        "deviceorientation",
        state.orientationHandler,
        true
      );
    }

    if (state.motionHandler) {
      window.removeEventListener(
        "devicemotion",
        state.motionHandler,
        true
      );
    }

    state.orientationHandler = null;
    state.motionHandler = null;
    state.heading = null;
    state.motionDetected = false;

    setText("sensor-status", "Sensor listening stopped.");
    updateStats();
  }

  function explainPositioning() {
    setText(
      "assistant-message",
      "GPS-free positioning needs reference information. A compass gives direction, not location. Motion sensors can estimate movement but drift over time. Wi-Fi positioning needs network identifiers and a location database or service. Bluetooth positioning needs known beacons. These systems are not implemented in this prototype yet."
    );
  }

  document.addEventListener("DOMContentLoaded", () => {
    initMap();

    $("set-origin").addEventListener("click", setOrigin);
    $("enable-sensors").addEventListener("click", enableSensors);
    $("stop-sensors").addEventListener("click", stopSensors);
    $("explain-positioning").addEventListener(
      "click",
      explainPositioning
    );

    $("reset-estimate").addEventListener("click", () => {
      if (!state.origin) {
        setText("assistant-message", "Set a starting point first.");
        return;
      }

      if (state.map) {
        state.map.setView(
          [state.origin.lat, state.origin.lon],
          16
        );
      }

      setText(
        "assistant-message",
        "Map returned to the manually set starting point."
      );
    });

    $("center-map").addEventListener("click", () => {
      if (!state.map) return;

      state.map.setView(
        state.origin
          ? [state.origin.lat, state.origin.lon]
          : [61.4981, 23.7600],
        state.origin ? 16 : 12
      );
    });

    updateStats();
  });
})();
