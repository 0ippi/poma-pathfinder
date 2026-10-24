
const $ = (id) => document.getElementById(id);

// --------------------
// MAP AND GPS
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
      "Karttakirjastoa ei saatu ladattua. Tarkista internetyhteys.";
    return;
  }

  map = L.map("map").setView([61.4991, 23.7871], 12);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);

  mapStatus.textContent =
    "Kartta valmis. Paina Find my location paikantaaksesi itsesi.";

  // Varmistaa kartan oikean koon myös mobiiliselaimissa.
  setTimeout(() => map.invalidateSize(), 100);
}

function showLocation(position) {
  const { latitude, longitude, accuracy } = position.coords;
  const point = [latitude, longitude];

  $("gps-lat").textContent = latitude.toFixed(6);
  $("gps-lon").textContent = longitude.toFixed(6);
  $("gps-accuracy").textContent = `±${Math.round(accuracy)} m`;

  if (!map) {
    mapStatus.textContent = "Sijainti saatiin, mutta kartta ei ole käytettävissä.";
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

    userMarker.bindPopup("Sijaintisi");

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
    `Sijainti päivitetty. Tarkkuus noin ${Math.round(accuracy)} m.`;

  connection.textContent = "● Location available";
}

function showLocationError(error) {
  const messages = {
    1: "Sijaintilupa evättiin. Salli sijainnin käyttö selaimen asetuksista.",
    2: "Sijaintia ei saatu. Tarkista puhelimen sijaintiasetukset.",
    3: "Paikannus aikakatkaistiin. Yritä uudelleen."
  };

  mapStatus.textContent =
    messages[error.code] || "Sijainnin hakeminen epäonnistui.";

  connection.textContent = "● Location unavailable";
}

function requestLocation() {
  if (!window.isSecureContext) {
    mapStatus.textContent = "Paikannus vaatii HTTPS-yhteyden.";
    return;
  }

  if (!navigator.geolocation) {
    mapStatus.textContent = "Selain ei tue paikannusta.";
    return;
  }

  mapStatus.textContent = "Haetaan sijaintia...";

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
    mapStatus.textContent = "Jatkuva paikannus vaatii HTTPS-yhteyden.";
    return;
  }

  if (gpsWatchId !== null) return;

  mapStatus.textContent = "Käynnistetään jatkuvaa paikannusta...";

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
  mapStatus.textContent = "Jatkuva paikannus pysäytetty.";
});

// --------------------
// PHONE SENSORS AND COMPASS
// --------------------

let sensorsStarted = false;

function getCompassHeading(event) {
  // iOS Safari voi tarjota suoraan kompassisuunnan.
  if (typeof event.webkitCompassHeading === "number") {
    return event.webkitCompassHeading;
  }

  // Muissa selaimissa alpha on laiteasennon kulma,
  // eikä se kaikissa laitteissa vastaa kompassisuuntaa.
  if (typeof event.alpha === "number") {
    return (360 - event.alpha) % 360;
  }

  return null;
}

function updateCompass(event) {
  const heading = getCompassHeading(event);
  if (heading === null) return;

  const degrees = Math.round(heading);
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const direction = directions[Math.round(degrees / 45) % 8];

  $("real-heading").textContent = `${direction} · ${degrees}°`;
  $("compass-arrow").style.transform = `rotate(${degrees}deg)`;
  $("compass-label").textContent = direction;
}

$("enable-sensors").addEventListener("click", async () => {
  const status = $("sensor-status");
  const button = $("enable-sensors");

  if (sensorsStarted) {
    status.textContent = "Sensorit ovat jo käytössä.";
    return;
  }

  button.disabled = true;
  status.textContent = "Pyydetään sensorien käyttöoikeutta...";

  try {
    if (!window.isSecureContext) {
      throw new Error("Sensorit vaativat HTTPS-yhteyden.");
    }

    if (typeof DeviceOrientationEvent === "undefined") {
      throw new Error("Selain ei tue suunta-anturia.");
    }

    // iOS Safari vaatii käyttäjän luvan.
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      const permission = await DeviceOrientationEvent.requestPermission();

      if (permission !== "granted") {
        throw new Error("Suunta-anturin käyttöoikeus evättiin.");
      }
    }

    window.addEventListener("deviceorientation", updateCompass);

    window.addEventListener("devicemotion", (event) => {
      const a = event.accelerationIncludingGravity;

      if (a && a.x !== null && a.y !== null && a.z !== null) {
        $("real-motion").textContent =
          `X ${a.x.toFixed(1)} · Y ${a.y.toFixed(1)} · Z ${a.z.toFixed(1)}`;
      }
    });

    sensorsStarted = true;
    status.textContent =
      "Sensorit käynnistetty. Käännä puhelinta ja tarkkaile kompassia.";
  } catch (error) {
    status.textContent =
      error.message || "Sensorien käyttö epäonnistui.";
  } finally {
    button.disabled = false;
  }
});

// --------------------
// SIMULATED NAVIGATION
// --------------------

let demoDistance = 0;
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

function resetDemo() {
  demoDistance = 0;
  demoHeading = 0;
  updateDemo();
}

$("start").addEventListener("click", resetDemo);

$("move").addEventListener("click", () => {
  demoDistance += 10;
  demoHeading = (demoHeading + 45) % 360;
  updateDemo();
});

$("reset").addEventListener("click", resetDemo);

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
      "Poma näyttää puhelimen ilmoittaman sijainnin. Tarkkuus riippuu saatavilla olevista signaaleista.";
  } else if (q.includes("wifi")) {
    answer =
      "Android voi käyttää Wi-Fi-verkkoja paikannuksen apuna, mutta verkkosivu ei voi suoraan skannata lähellä olevia Wi-Fi-verkkoja.";
  } else if (q.includes("compass") || q.includes("heading") || q.includes("suunta")) {
    answer =
      "Kompassi käyttää puhelimen suunta-anturia. Lukema voi olla epätarkka tai kalibroimaton.";
  } else if (q.includes("offline")) {
    answer =
      "Sovellus voi toimia osittain ilman yhteyttä, mutta karttalaatat tarvitsevat internetin, ellei niitä tallenneta erikseen.";
  } else {
    answer =
      "Olen Poman esittelyavustaja. Käytän valmiita vastauksia enkä ole yhteydessä oikeaan tekoälyyn.";
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
