const trader = require("./trader.js");
require("dotenv").config();

const WebSocket = require("ws");
const http = require("http");

const WS_URL = "wss://pumpportal.fun/api/data";
const SERVER = "http://127.0.0.1:3000";

let ws;
let reconnectTimer;
let botRunning = false;
let config = {};
const positions = new Map();

console.log("================================");
console.log("PUMP.FUN AUTO SNIPER");
console.log("================================");
console.log("MODE: AUTO");
console.log("BUY: AUTO");
console.log("SELL: AUTO");
console.log("================================");

function request(path, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;

    const req = http.request(
      `${SERVER}${path}`,
      {
        method,
        headers: data
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(data)
            }
          : {}
      },
      (res) => {
        let result = "";

        res.on("data", (chunk) => {
          result += chunk;
        });

        res.on("end", () => {
          try {
            resolve(JSON.parse(result || "{}"));
          } catch {
            resolve({});
          }
        });
      }
    );

    req.on("error", reject);

    if (data) req.write(data);

    req.end();
  });
}

async function loadConfig() {
  try {
    const result = await request("/api/config");

    config = result || {};
    botRunning = config.botRunning === true;

  } catch (error) {
    console.log("Server connection error:", error.message);
  }
}

async function savePosition(position) {
  try {
    await request("/api/position", "POST", position);
  } catch (error) {
    console.log("Position save error:", error.message);
  }
}

async function removePosition(mint) {
  try {
    await request(
      `/api/position/${encodeURIComponent(mint)}`,
      "DELETE"
    );
  } catch (error) {
    console.log("Position remove error:", error.message);
  }
}

function startAutomaticSell(token) {
  const holdSeconds = Number(config.holdSeconds || 30);
  const holdMs = holdSeconds * 1000;

  console.log("");
  console.log("⏱️ AUTO SELL TIMER");
  console.log("Token:", token.symbol);
  console.log("Hold:", holdSeconds, "seconds");

  setTimeout(async () => {
    if (!positions.has(token.mint)) return;

    console.log("");
    console.log("🔴 AUTO SELL SIGNAL");
    console.log("Token:", token.symbol);
    console.log("Mint:", token.mint);
  await fetch("http://127.0.0.1:3000/api/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(token) });
    console.log("Reason: HOLD TIME FINISHED");

    positions.delete(token.mint);

    await removePosition(token.mint);

    console.log("SELL: READY");
  }, holdMs);
}

async function handleNewToken(data) {
  if (!data.mint) return;

  if (!botRunning) return;

  if (config.newTokens === false) return;

  const maxPositions = Number(config.maxOpenPositions || 10);

  if (positions.size >= maxPositions) {
    console.log("MAX OPEN POSITIONS REACHED");
    return;
  }

  if (positions.has(data.mint)) return;

  const token = {
    name: data.name || "N/A",
    symbol: data.symbol || "N/A",
    mint: data.mint,
    creator: data.traderPublicKey || "N/A",
    signature: data.signature || "N/A",
    initialBuy: data.initialBuy ?? null,
    marketCapSol: data.marketCapSol ?? null,
    bondingCurveKey: data.bondingCurveKey || "N/A",
    detectedAt: Date.now()
  };

  console.log("");
  console.log("================================");
  console.log("🆕 NEW TOKEN");
  console.log("================================");
  console.log("Name:", token.name);
  console.log("Symbol:", token.symbol);
  console.log("Mint:", token.mint);
  await fetch("http://127.0.0.1:3000/api/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(token) });

  const position = {
    mint: token.mint,
    symbol: token.symbol,
    name: token.name,
    amountUsd: Number(config.amountUsd || 5),
    status: "AUTO_BUY",
    openedAt: Date.now()
  };

  positions.set(token.mint, position);

  console.log("");
  console.log("🟢 AUTO BUY");
  console.log("Token:", token.symbol);
  console.log("Amount: $" + position.amountUsd);

  await savePosition(position);

  startAutomaticSell(token);
}

function connect() {
  ws = new WebSocket(WS_URL);

  ws.on("open", async () => {
    console.log("");
    console.log("CONNECTED: YES");

    await loadConfig();

    ws.send(
      JSON.stringify({
        method: "subscribeNewToken"
      })
    );

    console.log("Subscribed: NEW TOKEN CREATIONS");
    console.log("Bot running:", botRunning ? "YES" : "NO");
    console.log("================================");
  });

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      await loadConfig();

      await handleNewToken(data);

    } catch (error) {
      console.log("Message error:", error.message);
    }
  });

  ws.on("error", (error) => {
    console.log("WebSocket error:", error.message);
  });

  ws.on("close", () => {
    console.log("");
    console.log("WebSocket disconnected.");
    console.log("Reconnecting in 3 seconds...");

    clearTimeout(reconnectTimer);

    reconnectTimer = setTimeout(() => {
      connect();
    }, 3000);
  });
}

loadConfig().then(() => {
  connect();
});
