"use strict";

require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, "runtime-config.json");
const DATA_DIR = path.join(ROOT, "data");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
app.use(express.json({ limit: "32kb" }));

const defaults = {
  running: false,
  liveTrading: false,
  buyAmountSol: 0.01,
  takeProfitPercent: 50,
  stopLossPercent: 10,
  holdSeconds: 30,
  maxOpenPositions: 3,
  slippagePercent: 20
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function readConfig() {
  return { ...defaults, ...readJson(CONFIG_FILE, {}) };
}
function writeConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
function readHistory() {
  return readJson(HISTORY_FILE, []);
}
function log(message, level = "info") {
  const entry = { time: new Date().toISOString(), level, message };
  console.log(`[${entry.time}] ${level.toUpperCase()}: ${message}`);
  const history = readHistory();
  history.unshift(entry);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, 200), null, 2));
}

let botProcess = null;
let botStarting = false;
let botOutput = "";

function botStatus() {
  return {
    running: Boolean(botProcess && botProcess.exitCode === null && !botProcess.killed),
    starting: botStarting,
    pid: botProcess?.pid ?? null,
    output: botOutput.slice(-5000)
  };
}

function startBot() {
  if (botStarting || (botProcess && botProcess.exitCode === null && !botProcess.killed)) {
    return { ok: true, message: "Boti është tashmë aktiv ose po niset." };
  }

  if (!fs.existsSync(path.join(ROOT, "bot.js"))) {
    return { ok: false, error: "Mungon bot.js." };
  }

  botStarting = true;
  botOutput = "";
  const child = spawn(process.execPath, [path.join(ROOT, "bot.js")], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  botProcess = child;

  const collect = (chunk, level) => {
    const line = chunk.toString();
    botOutput = (botOutput + line).slice(-5000);
    line.split(/\r?\n/).filter(Boolean).forEach(s => log(s, level));
  };
  child.stdout.on("data", chunk => collect(chunk, "info"));
  child.stderr.on("data", chunk => collect(chunk, "error"));
  child.on("spawn", () => {
    botStarting = false;
    log("Procesi bot.js u nis.");
  });
  child.on("error", err => {
    botStarting = false;
    log(`Nuk u nis bot.js: ${err.message}`, "error");
  });
  child.on("exit", (code, signal) => {
    botStarting = false;
    const config = readConfig();
    config.running = false;
    writeConfig(config);
    log(`Procesi bot.js përfundoi (code=${code}, signal=${signal}).`,
      code === 0 ? "info" : "error");
  });

  return { ok: true, message: "Kërkesa për nisjen e botit u dërgua." };
}

function stopBot() {
  const config = readConfig();
  config.running = false;
  writeConfig(config);

  if (botProcess && botProcess.exitCode === null && !botProcess.killed) {
    botProcess.kill("SIGTERM");
    log("Kërkesa STOP u dërgua.");
  }
  return { ok: true, message: "Kërkesa STOP u dërgua." };
}

app.get("/", (_req, res) => res.sendFile(path.join(ROOT, "dashboard.html")));

app.get("/api/status", (_req, res) => {
  res.json({
    config: readConfig(),
    bot: botStatus(),
    history: readHistory().slice(0, 60)
  });
});

app.post("/api/config", (req, res) => {
  const old = readConfig();
  const body = req.body || {};
  const numeric = [
    "buyAmountSol", "takeProfitPercent", "stopLossPercent",
    "holdSeconds", "maxOpenPositions", "slippagePercent"
  ];

  const next = { ...old };
  for (const key of numeric) {
    if (body[key] !== undefined) {
      const value = Number(body[key]);
      if (!Number.isFinite(value)) {
        return res.status(400).json({ ok: false, error: `${key} duhet të jetë numër.` });
      }
      next[key] = value;
    }
  }

  if (body.liveTrading !== undefined) {
    if (body.liveTrading === true && process.env.ALLOW_REAL_TRADING !== "YES") {
      return res.status(403).json({
        ok: false,
        error: "Live trading është i bllokuar. Konfiguro ALLOW_REAL_TRADING=YES vetëm pasi të testosh botin."
      });
    }
    next.liveTrading = Boolean(body.liveTrading);
  }

  if (next.buyAmountSol <= 0 || next.buyAmountSol > 100 ||
      next.takeProfitPercent <= 0 || next.takeProfitPercent > 10000 ||
      next.stopLossPercent <= 0 || next.stopLossPercent > 100 ||
      next.holdSeconds < 1 || next.holdSeconds > 86400 ||
      next.maxOpenPositions < 1 || next.maxOpenPositions > 50 ||
      next.slippagePercent < 0 || next.slippagePercent > 100) {
    return res.status(400).json({ ok: false, error: "Një ose më shumë parametra janë jashtë kufijve të lejuar." });
  }

  writeConfig(next);
  log("Konfigurimi u ruajt.");
  res.json({ ok: true, config: next });
});

app.post("/api/start", (_req, res) => {
  const result = startBot();
  if (result.ok) {
    const config = readConfig();
    config.running = true;
    writeConfig(config);
  }
  res.status(result.ok ? 200 : 500).json(result);
});

app.post("/api/stop", (_req, res) => res.json(stopBot()));

const server = app.listen(PORT, "0.0.0.0", () => {
  log(`Solana Sniper Bot dashboard: port ${PORT}`);
  log("Tregtimi real është i çaktivizuar si parazgjedhje.");
});

function shutdown() {
  stopBot();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
