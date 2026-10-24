
const $ = (id) => document.getElementById(id);

// GPS
const gpsButton = $("enable-gps");
const gpsPosition = $("gps-position");
const gpsAccuracy = $("gps-accuracy");
const gpsStatus = $("gps-status");

let gpsWatchId = null;

gpsButton.addEventListener("click", () => {
  if (!("geolocation" in navigator)) {
    gpsStatus.textContent = "Geolocation is not supported.";
    return;
  }

  if (!window.isSecureContext) {
    gpsStatus.textContent = "GPS requires HTTPS or localhost.";
    return;
  }

  gpsButton.disabled = true;
  gpsStatus.textContent = "Requesting location permission...";

  navigator.geolocation.getCurrentPosition(
    (position) => {
      showGPS(position);
      gpsStatus.textContent = "GPS location received.";
      gpsButton.disabled = false;
    },
    (error) => {
      gpsStatus.textContent = gpsError(error);
      gpsButton.disabled = false;
    },
    {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0
    }
  );
});

function showGPS(position) {
  const lat = position.coords.latitude;
  const lon = position.coords.longitude;
  const accuracy = position.coords.accuracy;

  gpsPosition.textContent =
    `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

  gpsAccuracy.textContent = `±${Math.round(accuracy)} m`;
}

function gpsError(error) {
  switch (error.code) {
    case 1:
      return "Location permission denied. Allow location access in Chrome.";
    case 2:
      return "Position unavailable. Check phone location settings.";
    case 3:
      return "Location request timed out. Try again.";
    default:
      return "Could not obtain location.";
  }
}

// Optional continuous GPS updates
// Call startGPSUpdates() when you want continuous tracking.
function startGPSUpdates() {
  if (!navigator.geolocation || !window.isSecureContext) {
    gpsStatus.textContent = "GPS requires a supported browser and HTTPS.";
    return;
  }

  if (gpsWatchId !== null) return;

  gpsWatchId = navigator.geolocation.watchPosition(
    (position) => {
      showGPS(position);
      gpsStatus.textContent = "Live location updates active.";
    },
    (error) => {
      gpsStatus.textContent = gpsError(error);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 15000
    }
  );
}

function stopGPSUpdates() {
  if (gpsWatchId !== null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
    gpsStatus.textContent = "Live location updates stopped.";
  }
}

// Phone sensors
const sensorButton = $("enable-sensors");
const realHeading = $("real-heading");
const realMotion = $("real-motion");
const sensorStatus = $("sensor-status");

sensorButton.addEventListener("click", async () => {
  sensorButton.disabled = true;
  sensorStatus.textContent = "Checking sensor access...";

  try {
    if (!window.isSecureContext) {
      throw new Error("Sensors require HTTPS.");
    }

    if (typeof DeviceOrientationEvent === "undefined") {
      throw new Error("Orientation sensor unavailable.");
    }

    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      const permission =
        await DeviceOrientationEvent.requestPermission();

      if (permission !== "granted") {
        throw new Error("Orientation permission denied.");
      }
    }

    window.addEventListener("deviceorientation", (event) => {
      if (event.alpha !== null) {
        realHeading.textContent =
          `${Math.round(event.alpha)}° (raw)`;
      }
    });

    window.addEventListener("devicemotion", (event) => {
      const a = event.accelerationIncludingGravity;

      if (a && a.x !== null && a.y !== null && a.z !== null) {
        realMotion.textContent =
          `X ${a.x.toFixed(1)} · Y ${a.y.toFixed(1)} · Z ${a.z.toFixed(1)}`;
      }
    });

    sensorStatus.textContent =
      "Listening for sensor readings. Move your phone to test.";
  } catch (error) {
    sensorStatus.textContent = error.message ||
      "Could not access sensors. Check browser permissions.";
  } finally {
    sensorButton.disabled = false;
  }
});

// Demo navigation
const map = $("map");
const marker = $("marker");
const uncertainty = $("uncertainty");
const position = $("position");
const distance = $("distance");
const heading = $("heading");

let demoDistance = 0;
let demoX = 50;
let demoY = 50;
let demoHeading = 0;

function updateDemo() {
  position.textContent = "Simulated position";
  distance.textContent = `${demoDistance} m`;
  heading.textContent =
    `${compassLabel(demoHeading)} · ${demoHeading}°`;

  marker.style.left = `${demoX}%`;
  marker.style.top = `${demoY}%`;

  if (uncertainty) {
    const size = Math.min(12 + demoDistance / 8, 45);
    uncertainty.style.width = `${size}%`;
    uncertainty.style.height = `${size}%`;
    uncertainty.style.left = `${demoX}%`;
    uncertainty.style.top = `${demoY}%`;
  }
}

function compassLabel(degrees) {
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][
    Math.round(degrees / 45) % 8
  ];
}

$("start").addEventListener("click", () => {
  demoDistance = 0;
  demoX = 50;
  demoY = 50;
  demoHeading = 0;
  updateDemo();
});

$("move").addEventListener("click", () => {
  demoDistance += 10;
  demoHeading = (demoHeading + 45) % 360;

  demoX = Math.max(10, Math.min(90, demoX + Math.cos(demoHeading * Math.PI / 180) * 5));
  demoY = Math.max(10, Math.min(90, demoY + Math.sin(demoHeading * Math.PI / 180) * 5));

  updateDemo();
});

$("reset").addEventListener("click", () => {
  demoDistance = 0;
  demoX = 50;
  demoY = 50;
  demoHeading = 0;
  updateDemo();
});

updateDemo();

// Simple offline assistant demo
const chatForm = $("chat-form");
const questionInput = $("question");
const messages = $("messages");

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const question = questionInput.value.trim();
  if (!question) return;

  addMessage(`You: ${question}`);

  const q = question.toLowerCase();
  let answer;

  if (q.includes("gps")) {
    answer = "GPS uses satellite signals. Poma can display the position provided by your phone.";
  } else if (q.includes("wifi")) {
    answer = "Android may use Wi-Fi networks for location, but a normal webpage cannot directly scan nearby Wi-Fi networks.";
  } else if (q.includes("compass") || q.includes("heading")) {
    answer = "The orientation sensor gives a raw orientation reading. It is not always a calibrated compass heading.";
  } else if (q.includes("offline")) {
    answer = "Poma's interface works offline once cached, but GPS and sensor availability depend on your device.";
  } else {
    answer = "I'm the Poma demo assistant. I can explain GPS, Wi-Fi location and phone sensors, but I am not connected to a real AI.";
  }

  addMessage(`Poma: ${answer}`);
  questionInput.value = "";
});

function addMessage(text) {
  const p = document.createElement("p");
  p.className = "message";
  p.textContent = text;
  messages.appendChild(p);
}
