
"use strict";

require("dotenv").config();

const WebSocket = require("ws");
const http = require("http");
const trader = require("./trader.js");

const WS_URL = "wss://pumpportal.fun/api/data";
const SERVER = "http://127.0.0.1:3000";

let ws;
let reconnectTimer;
let botRunning = false;
let config = {};
let connecting = false;

const positions = new Map();
const processing = new Set();
const seen = new Set();

function request(path, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`${SERVER}${path}`, {
      method,
      headers: data ? {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data)
      } : {}
    }, res => {
      let output = "";
      res.on("data", chunk => output += chunk);
      res.on("end", () => {
        let parsed = {};
        try { parsed = JSON.parse(output || "{}"); } catch {}
        if (res.statusCode >= 400) {
          return reject(new Error(`Dashboard HTTP ${res.statusCode}`));
        }
        resolve(parsed);
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error("Dashboard timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function loadConfig() {
  const result = await request("/api/config");
  config = result || {};
  botRunning = config.botRunning === true;
}

async function dashboardToken(token) {
  try {
    await request("/api/token", "POST", token);
  } catch (e) {
    console.log("Dashboard token update failed:", e.message);
  }
}

async function savePosition(position) {
  await request("/api/position", "POST", position);
}

async function removePosition(mint) {
  positions.delete(mint);
  try {
    await request(`/api/position/${encodeURIComponent(mint)}`, "DELETE");
  } catch (e) {
    console.log("Position cleanup failed:", e.message);
  }
}

function getSolUsd() {
  return Number(config.solPriceUsd || process.env.SOL_PRICE_USD || 0);
}

function amountSol() {
  const usd = Number(config.amountUsd || 0);
  const price = getSolUsd();
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error("amountUsd must be positive");
  }
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Set a current SOL_PRICE_USD in environment or solPriceUsd in dashboard config");
  }
  return usd / price;
}

async function buyNewToken(data) {
  const mint = data.mint;
  if (!mint || seen.has(mint) || processing.has(mint)) return;
  seen.add(mint);
  if (seen.size > 5000) seen.delete(seen.values().next().value);

  const token = {
    name: data.name || "N/A",
    symbol: data.symbol || "N/A",
    mint,
    creator: data.traderPublicKey || "N/A",
    signature: data.signature || "N/A",
    marketCapSol: data.marketCapSol ?? null,
    detectedAt: Date.now(),
    status: "DETECTED"
  };

  console.log("NEW TOKEN:", token.symbol, mint);
  await dashboardToken(token);

  if (!botRunning || config.newTokens === false) return;

  const max = Math.max(1, Number(config.maxOpenPositions || 1));
  if (positions.size >= max) {
    console.log("Skipping token: maximum open positions reached");
    return;
  }

  // Live trading remains locked unless both dashboard switches and
  // ALLOW_REAL_TRADING=YES are explicitly set.
  if (config.realBuy !== true || config.realSell !== true ||
      process.env.ALLOW_REAL_TRADING !== "YES") {
    console.log("Detection only: BUY/SELL safety switches are OFF.");
    return;
  }

  processing.add(mint);
  try {
    await trader.inspectToken(mint);
    const sol = amountSol();

    console.log(`BUY request: ${token.symbol}, ${sol} SOL`);
    const result = await trader.buyToken({
      mintAddress: mint,
      solAmount: sol,
      slippage: Number(config.buySlippagePercent ?? 20),
      realBuy: true
    });

    if (!result || result.ok !== true || result.confirmed !== true ||
        !result.signature) {
      console.log("BUY not confirmed; no position created.", result);
      return;
    }

    // Do not pretend to know a reliable entry price from the token-creation
    // event. TP/SL needs a trustworthy quote source before it can be enabled.
    const position = {
      mint,
      symbol: token.symbol,
      name: token.name,
      buySignature: result.signature,
      tokenAmountRaw: result.tokenAmount,
      quoteAmountRaw: result.quoteAmount,
      openedAt: Date.now(),
      status: "BOUGHT_TP_SL_NOT_ARMED",
      note: "Entry market quote not verified; automatic TP/SL disabled."
    };

    positions.set(mint, position);
    await savePosition(position);
    console.log("BUY CONFIRMED:", token.symbol, result.signature);
    console.log("WARNING: automatic TP/SL is not armed; monitor this position manually.");
  } catch (e) {
    console.log("BUY FAILED:", mint, e.message);
  } finally {
    processing.delete(mint);
  }
}

async function connect() {
  if (connecting) return;
  connecting = true;

  try {
    await loadConfig();
  } catch (e) {
    console.log("Dashboard config unavailable:", e.message);
    connecting = false;
    scheduleReconnect();
    return;
  }

  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    connecting = false;
    console.log("Connected to PumpPortal.");
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    console.log("Subscribed to new token creations.");
  });

  ws.on("message", async raw => {
    try {
      const data = JSON.parse(raw.toString());
      await loadConfig();
      await buyNewToken(data);
    } catch (e) {
      console.log("Message handler error:", e.message);
    }
  });

  ws.on("error", e => console.log("WebSocket error:", e.message));

  ws.on("close", () => {
    connecting = false;
    console.log("WebSocket disconnected.");
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(), 3000);
}

process.on("SIGINT", () => {
  clearTimeout(reconnectTimer);
  if (ws) ws.close();
  console.log("Bot stopped.");
  process.exit(0);
});

connect();


// Controlled SELL helper: only sells an existing tracked position.
async function sellTrackedPosition(mint) {
  const position = positions.get(mint);

  if (!position) {
    console.log("SELL skipped: no tracked position for", mint);
    return { ok: false, reason: "Position not found" };
  }

  if (config.realSell !== true || process.env.ALLOW_REAL_TRADING !== "YES") {
    console.log("SELL blocked: real-sell safety switches are OFF.");
    return { ok: false, reason: "Safety switches are OFF" };
  }

  try {
    console.log("SELL requested for", position.symbol || mint);

    const result = await trader.sellToken({
      mintAddress: mint,
      slippage: Number(config.sellSlippagePercent ?? 1),
      realSell: true
    });

    if (result?.ok === true && result?.confirmed === true) {
      positions.delete(mint);
      await request(`/api/position/${encodeURIComponent(mint)}`, "DELETE");
      console.log("SELL CONFIRMED:", result.signature);
      return result;
    }

    console.log("SELL not confirmed; position retained.", result);
    return result;
  } catch (error) {
    console.error("SELL FAILED:", mint, error.message);
    return { ok: false, error: error.message };
  }
}


let sellPollBusy = false;
// SELL REQUEST POLLER
setInterval(async () => {
  if (sellPollBusy) return;
  sellPollBusy = true;
  try {
    const result = await request("/api/sell-requests");
    for (const mint of (result.requests || [])) {
      await sellTrackedPosition(mint);
    }
  } catch (e) {
    console.log("SELL poll error:", e.message);
  } finally {
    sellPollBusy = false;
  }
}, 750);
