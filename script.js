
const $ = (id) => document.getElementById(id);

// --------------------
// REAL MAP
// --------------------

const mapStatus = $("map-status");
const connection = $("connection");

let map = null;
let userMarker = null;
let accuracyCircle = null;
let gpsWatchId = null;

function initializeMap() {
  if (typeof L === "undefined") {
    mapStatus.textContent =
      "Map library unavailable. Check your internet connection.";
    return;
  }

  map = L.map("map").setView([61.4991, 23.7871], 12);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  mapStatus.textContent =
    "Map ready. Press Find my location to locate yourself.";
}

function showLocation(position) {
  const { latitude, longitude, accuracy } = position.coords;
  const point = [latitude, longitude];

  $("gps-lat").textContent = latitude.toFixed(6);
  $("gps-lon").textContent = longitude.toFixed(6);
  $("gps-accuracy").textContent = `±${Math.round(accuracy)} m`;

  if (!map) {
    mapStatus.textContent =
      "Location received, but the map has not loaded.";
    return;
  }

  if (!userMarker) {
    userMarker = L.circleMarker(point, {
      radius: 8,
      color: "#ffffff",
      weight: 3,
      fillColor: "#16a5ff",
      fillOpacity: 1
    }).addTo(map);

    userMarker.bindPopup("Your reported location");

    accuracyCircle = L.circle(point, {
      radius: accuracy,
      color: "#16a5ff",
      fillColor: "#16a5ff",
      fillOpacity: 0.12,
      weight: 2
    }).addTo(map);
  } else {
    userMarker.setLatLng(point);
    accuracyCircle.setLatLng(point);
    accuracyCircle.setRadius(accuracy);
  }

  map.setView(point, 16);
  mapStatus.textContent =
    `Location updated. Reported accuracy: about ${Math.round(accuracy)} m.`;

  connection.textContent = "● Location available";
}

function showLocationError(error) {
  const messages = {
    1: "Location permission denied. Allow location access in Chrome.",
    2: "Location unavailable. Check your phone's location settings.",
    3: "Location request timed out. Try again."
  };

  mapStatus.textContent =
    messages[error.code] || "Could not get your location.";

  connection.textContent = "● Location unavailable";
}

function requestLocation() {
  if (!window.isSecureContext) {
    mapStatus.textContent =
      "Location requires HTTPS. Open the published GitHub Pages URL.";
    return;
  }

  if (!navigator.geolocation) {
    mapStatus.textContent =
      "This browser does not support location access.";
    return;
  }

  mapStatus.textContent = "Requesting location...";

  navigator.geolocation.getCurrentPosition(
    showLocation,
    showLocationError,
    {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 0
    }
  );
}

$("enable-gps").addEventListener("click", requestLocation);

$("follow-gps").addEventListener("click", () => {
  if (!window.isSecureContext || !navigator.geolocation) {
    mapStatus.textContent =
      "Live location requires HTTPS and browser location support.";
    return;
  }

  if (gpsWatchId !== null) return;

  mapStatus.textContent = "Starting live location tracking...";

  gpsWatchId = navigator.geolocation.watchPosition(
    showLocation,
    showLocationError,
    {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 20000
    }
  );

  $("follow-gps").disabled = true;
});

$("stop-gps").addEventListener("click", () => {
  if (gpsWatchId !== null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }

  $("follow-gps").disabled = false;
  mapStatus.textContent = "Live tracking stopped.";
});

// --------------------
// PHONE SENSORS
// --------------------

let sensorsStarted = false;

$("enable-sensors").addEventListener("click", async () => {
  const status = $("sensor-status");
  const button = $("enable-sensors");

  if (sensorsStarted) {
    status.textContent = "Sensor listeners are already active.";
    return;
  }

  button.disabled = true;
  status.textContent = "Requesting sensor access...";

  try {
    if (!window.isSecureContext) {
      throw new Error("Sensors require an HTTPS page.");
    }

    if (typeof DeviceOrientationEvent === "undefined") {
      throw new Error("Orientation sensor is unavailable.");
    }

    if (
      typeof DeviceOrientationEvent.requestPermission === "function"
    ) {
      const permission =
        await DeviceOrientationEvent.requestPermission();

      if (permission !== "granted") {
        throw new Error("Orientation permission was denied.");
      }
    }

    let orientationSeen = false;
    let motionSeen = false;

    window.addEventListener("deviceorientation", (event) => {
      if (event.alpha !== null) {
        orientationSeen = true;
        $("real-heading").textContent =
          `${Math.round(event.alpha)}° (raw orientation)`;
      }
    });

    window.addEventListener("devicemotion", (event) => {
      const a = event.accelerationIncludingGravity;

      if (a && a.x !== null && a.y !== null && a.z !== null) {
        motionSeen = true;
        $("real-motion").textContent =
          `X ${a.x.toFixed(1)} · Y ${a.y.toFixed(1)} · Z ${a.z.toFixed(1)}`;
      }
    });

    sensorsStarted = true;
    status.textContent =
      "Sensor listeners started. Move and rotate your phone to test.";
  } catch (error) {
    status.textContent =
      error.message || "Could not access phone sensors.";
  } finally {
    button.disabled = false;
  }
});

// --------------------
// SIMULATED NAVIGATION
// --------------------

let demoDistance = 0;
let demoX = 50;
let demoY = 50;
let demoHeading = 0;

function compassLabel(degrees) {
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][
    Math.round(degrees / 45) % 8
  ];
}

function updateDemo() {
  $("position").textContent = "Simulated position";
  $("distance").textContent = `${demoDistance} m`;
  $("heading").textContent =
    `${compassLabel(demoHeading)} · ${demoHeading}°`;
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

  demoX = Math.max(
    10,
    Math.min(
      90,
      demoX + Math.cos(demoHeading * Math.PI / 180) * 5
    )
  );

  demoY = Math.max(
    10,
    Math.min(
      90,
      demoY + Math.sin(demoHeading * Math.PI / 180) * 5
    )
  );

  updateDemo();
});

$("reset").addEventListener("click", () => {
  demoDistance = 0;
  demoX = 50;
  demoY = 50;
  demoHeading = 0;
  updateDemo();
});

// --------------------
// SIMPLE OFFLINE ASSISTANT
// --------------------

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

  if (q.includes("gps") || q.includes("location")) {
    answer =
      "Poma can display the location supplied by your phone. Accuracy depends on available signals.";
  } else if (q.includes("wifi")) {
    answer =
      "Android may use Wi-Fi for location, but this webpage cannot directly scan nearby Wi-Fi networks.";
  } else if (q.includes("compass") || q.includes("heading")) {
    answer =
      "The orientation sensor gives a raw reading. It is not always a calibrated compass heading.";
  } else if (q.includes("offline")) {
    answer =
      "The app interface can work offline once loaded, but map tiles and location services may need connectivity.";
  } else {
    answer =
      "I'm the Poma demo assistant. I use simple built-in replies and am not connected to a real AI.";
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

initializeMap();
updateDemo();
