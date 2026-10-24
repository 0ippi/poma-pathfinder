
let started = false;
let distance = 0;
let heading = 0;
let x = 50;
let y = 50;

const position = document.getElementById("position");
const distanceText = document.getElementById("distance");
const headingText = document.getElementById("heading");
const marker = document.getElementById("marker");
const uncertainty = document.getElementById("uncertainty");

function updateDisplay() {
  position.textContent = started
    ? "Demo position · relative"
    : "Not established";

  distanceText.textContent = `${distance} m`;
  headingText.textContent = `${heading}°`;

  marker.style.left = `${x}%`;
  marker.style.top = `${y}%`;
  uncertainty.style.left = `${x}%`;
  uncertainty.style.top = `${y}%`;
}

document.getElementById("start").addEventListener("click", () => {
  started = true;
  document.getElementById("connection").textContent =
    "● Offline mode · Simulated data";
  updateDisplay();
});

document.getElementById("move").addEventListener("click", () => {
  if (!started) {
    alert("Start the demo first.");
    return;
  }

  distance += 10;
  heading = (heading + 45) % 360;

  const radians = heading * Math.PI / 180;
  x = Math.max(8, Math.min(92, x + Math.sin(radians) * 4));
  y = Math.max(8, Math.min(92, y - Math.cos(radians) * 4));

  uncertainty.style.width =
    `${90 + distance * 0.3}px`;
  uncertainty.style.height =
    `${90 + distance * 0.3}px`;

  updateDisplay();
});

document.getElementById("reset").addEventListener("click", () => {
  started = false;
  distance = 0;
  heading = 0;
  x = 50;
  y = 50;
  uncertainty.style.width = "90px";
  uncertainty.style.height = "90px";
  document.getElementById("connection").textContent =
    "● Offline mode · Demo";
  updateDisplay();
});

document.getElementById("chat-form").addEventListener("submit", (event) => {
  event.preventDefault();

  const input = document.getElementById("question");
  const question = input.value.trim().toLowerCase();

  if (!question) return;

  addMessage(input.value, true);
  input.value = "";

  let answer =
    "This demo does not have an AI model connected yet. Later, I can help analyze sensor data and environmental clues.";

  if (question.includes("gps") || question.includes("lost")) {
    answer =
      "Without GPS, Poma can combine a last known position, compass, motion sensors and recognizable landmarks. This demo does not calculate a real location.";
  } else if (question.includes("sensor") || question.includes("compass")) {
    answer =
      "The compass can estimate direction, while motion sensors help estimate movement. Sensor errors accumulate over time.";
  } else if (question.includes("location") || question.includes("sijaint")) {
    answer =
      started
        ? "The displayed position is simulated. Poma does not know your real location."
        : "No position has been established. Start the demo to see a simulated relative position.";
  }

  addMessage(answer, false);
});

function addMessage(text, isUser) {
  const message = document.createElement("p");
  message.className = "message";
  message.textContent = (isUser ? "You: " : "Poma: ") + text;
  document.getElementById("messages").appendChild(message);
  message.scrollIntoView({ block: "end", behavior: "smooth" });
}

updateDisplay();
