const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 3000;

const CONFIG_FILE = path.join(__dirname, "runtime-config.json");

const defaultConfig = {
  botRunning: false,
  amountUsd: 5,
  holdSeconds: 30,
  takeProfitPercent: 50,
  stopLossPercent: 10,
  maxOpenPositions: 10,
  newTokens: true,
  realBuy: false,
  realSell: false
};

let config = { ...defaultConfig };
let latestToken = null;
let positions = {};

if (fs.existsSync(CONFIG_FILE)) {
  try {
    config = {
      ...defaultConfig,
      ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"))
    };
  } catch {
    config = { ...defaultConfig };
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

app.use(express.json());
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/api/config", (req, res) => {
  res.json(config);
});

app.post("/api/config", (req, res) => {
  config = {
    ...config,
    ...req.body
  };

  saveConfig();

  console.log("CONFIG UPDATED:", config);

  res.json({
    ok: true,
    config
  });
});

app.post("/api/start", (req, res) => {
  config.botRunning = true;
  saveConfig();

  console.log("🟢 BOT STARTED");

  res.json({
    ok: true,
    botRunning: true
  });
});

app.post("/api/stop", (req, res) => {
  config.botRunning = false;
  saveConfig();

  console.log("🔴 BOT STOPPED");

  res.json({
    ok: true,
    botRunning: false
  });
});

app.post("/api/token", (req, res) => {
  latestToken = req.body;

  console.log(
    "🆕 TOKEN:",
    latestToken.symbol || latestToken.name || "UNKNOWN",
    latestToken.mint || ""
  );

  res.json({ ok: true });
});

app.get("/api/token", (req, res) => {
  res.json(latestToken || {});
});

app.get("/api/state", (req, res) => {
  res.json({
    config,
    latestToken,
    positions
  });
});

app.post("/api/position", (req, res) => {
  const position = req.body;

  if (!position.mint) {
    return res.status(400).json({
      ok: false,
      error: "Missing mint"
    });
  }

  positions[position.mint] = {
    ...position,
    openedAt: position.openedAt || Date.now()
  };

  res.json({
    ok: true,
    position: positions[position.mint]
  });
});

app.delete("/api/position/:mint", (req, res) => {
  delete positions[req.params.mint];

  res.json({ ok: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("================================");
  console.log("PUMP.FUN AUTO SNIPER SERVER");
  console.log("================================");
  console.log(`Dashboard running on port ${PORT}`);
  console.log("");
  console.log("START / STOP CONTROL: READY");
  console.log("Automatic token timing: READY");
  console.log("Real BUY: OFF");
  console.log("Real SELL: OFF");
  console.log("================================");
});
