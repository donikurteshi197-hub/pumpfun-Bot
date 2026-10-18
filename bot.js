
"use strict";

require("dotenv").config();

const WebSocket = require("ws");
const http = require("http");
const trader = require("./trader.js");

const WS_URL = process.env.PUMPPORTAL_API_KEY
  ? `wss://pumpportal.fun/api/data?api-key=${encodeURIComponent(process.env.PUMPPORTAL_API_KEY)}`
  : "wss://pumpportal.fun/api/data";
const SERVER = "http://127.0.0.1:3000";

let ws;
let reconnectTimer;
let botRunning = false;
let config = {};
let connecting = false;

const positions = new Map();
const processing = new Set();
let liveBuyInProgress = false;
const seen = new Set();
const exiting = new Set();
const exitTimers = new Map();

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
  const sol = Number(config.buyAmountSol);

  if (!Number.isFinite(sol) || sol <= 0) {
    throw new Error("Set a valid buyAmountSol in dashboard first");
  }

  return sol;
}

async function buyNewToken(data) {
  const mint = data.mint;
  if (!mint || processing.has(mint)) return;
  if (seen.has(mint)) return;
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

  if (!botRunning || config.newTokens === false) {
    console.log("BUY SKIPPED: botRunning =", botRunning, "| newTokens =", config.newTokens);
    return;
  }

  // MAYHEM-ONLY FILTER: before paper or live trading.
  try {
    const mayhemState = await trader.inspectToken(mint);

    if (mayhemState?.bondingCurve?.isMayhemMode !== true) {
      token.status = "SKIPPED_NON_MAYHEM";
      await dashboardToken(token);
      console.log("MAYHEM FILTER: ordinary token skipped:", token.symbol, mint);
      return;
    }

    console.log("MAYHEM FILTER: CONFIRMED", token.symbol, mint);
  } catch (error) {
    token.status = "SKIPPED_MAYHEM_UNCONFIRMED";
    await dashboardToken(token);
    console.log(
      "MAYHEM CHECK FAILED; token skipped:",
      token.symbol, mint, "|", error.message
    );
    return;
  }

  const max = Math.max(1, Number(config.maxOpenPositions || 1));
  if (positions.size >= max) {
    console.log("Skipping token: maximum open positions reached");
    return;
  }

  // PAPER MODE: simulate a position without sending a blockchain transaction.
  if (config.paperTrading === true) {
    const entry = Number(data.marketCapSol);
    if (!Number.isFinite(entry) || entry <= 0) {
      console.log("PAPER BUY SKIPPED: token has no valid marketCapSol:", mint);
      return;
    }

    if (positions.has(mint) || positions.size >= max) {
      console.log("PAPER BUY SKIPPED: duplicate token or position limit reached:", mint);
      return;
    }

    seen.add(mint);
    const position = {
      mint,
      symbol: token.symbol,
      name: token.name,
      buySignature: "PAPER",
      tokenAmountRaw: "0",
      quoteAmountRaw: "0",
      entryMarketCapSol: entry,
      currentMarketCapSol: entry,
      openedAt: Date.now(),
      status: "PAPER_TP_SL_ARMED",
      simulated: true,
      note: "Paper position only; no real transaction was sent."
    };

    positions.set(mint, position);
    await savePosition(position);
    subscribePositionTrades(mint);
    armTimeExit(mint);
    console.log("PAPER BUY:", token.symbol, mint, "| entry market cap:", entry);
    return;
  }

  // Live trading remains locked unless both dashboard switches and
  // ALLOW_REAL_TRADING=YES are explicitly set.
  if (config.realBuy !== true || config.realSell !== true ||
      process.env.ALLOW_REAL_TRADING !== "YES" ||
      !process.env.PUMPPORTAL_API_KEY) {
    console.log("BUY BLOCKED:", JSON.stringify({
      realBuy: config.realBuy === true,
      realSell: config.realSell === true,
      allowRealTrading: process.env.ALLOW_REAL_TRADING === "YES",
      pumpPortalKeyPresent: Boolean(process.env.PUMPPORTAL_API_KEY)
    }));
    return;
  }

  if (liveBuyInProgress) {
    console.log("BUY SKIPPED: another live buy is already in progress:", mint);
    return;
  }

  seen.add(mint);
  liveBuyInProgress = true;
  processing.add(mint);
  try {
    const sol = amountSol();

    console.log(`BUY request: ${token.symbol}, ${sol} SOL`);
    const result = await trader.buyToken({
      mintAddress: mint,
      solAmount: sol,
      slippage: Number(config.buySlippagePercent ?? 20) / 100,
      realBuy: true
    });

    if (!result || result.ok !== true || result.confirmed !== true ||
        !result.signature) {
      console.log("BUY not confirmed; no position created.", result);
      return;
    }

    const tokenRaw = BigInt(result.tokenAmount || "0");
    const quoteRaw = BigInt(result.quoteAmount || "0");
    // Pump.fun token supply is conventionally 1 billion tokens with 6 decimals.
    // This is an estimated entry market cap, not a guaranteed execution price.
    const entryMarketCapSol = tokenRaw > 0n
      ? Number(quoteRaw) * 1e6 / Number(tokenRaw)
      : 0;

    const entryPriceValid =
      Number.isFinite(entryMarketCapSol) && entryMarketCapSol > 0;

    const position = {
      mint,
      symbol: token.symbol,
      name: token.name,
      buySignature: result.signature,
      tokenAmountRaw: result.tokenAmount,
      quoteAmountRaw: result.quoteAmount,
      entryMarketCapSol: entryPriceValid ? entryMarketCapSol : 0,
      currentMarketCapSol: entryPriceValid ? entryMarketCapSol : 0,
      openedAt: Date.now(),
      status: entryPriceValid ? "TP_SL_ARMED" : "ENTRY_PRICE_UNAVAILABLE",
      note: entryPriceValid
        ? "TP/SL uses estimated entry market cap and PumpPortal marketCapSol updates."
        : "BUY confirmed; entry price unavailable. Check position and wallet before relying on TP/SL."
    };

    positions.set(mint, position);
    await savePosition(position);
    subscribePositionTrades(mint);
    armTimeExit(mint);
    console.log("BUY CONFIRMED:", token.symbol, result.signature);
    console.log("TP/SL armed using estimated entry market cap:", entryMarketCapSol, "SOL");
  } catch (e) {
    console.log("BUY FAILED:", mint, e.message);
  } finally {
    processing.delete(mint);
    liveBuyInProgress = false;
  }
}

function armTimeExit(mint, retry = false) {
  const position = positions.get(mint);
  if (!position) return;

  const previous = exitTimers.get(mint);
  if (previous) clearTimeout(previous);

  const seconds = retry
    ? 2
    : Math.max(1, Number(config.holdSeconds ?? 10));

  const timer = setTimeout(async () => {
    if (!positions.has(mint)) return;

    console.log(
      retry ? "TIME EXIT RETRY:" : "TIME EXIT:",
      position.symbol || mint,
      retry ? "retrying sale" : `hold limit ${seconds}s reached`
    );

    const result = await sellTrackedPosition(mint);

    if (result?.confirmed !== true && positions.has(mint)) {
      console.log("TIME EXIT not confirmed; will retry in 2 seconds.");
      armTimeExit(mint, true);
    }
  }, seconds * 1000);

  exitTimers.set(mint, timer);
}

function subscribePositionTrades(mint) {
  if (!process.env.PUMPPORTAL_API_KEY) {
    console.log("TP/SL feed unavailable: set PUMPPORTAL_API_KEY in .env.");
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));
    console.log("Subscribed to token trades for TP/SL:", mint);
  }
}

async function handleTradeUpdate(data) {
  const mint = data.mint;
  const position = positions.get(mint);
  if (!position) return;

  const marketCapSol = Number(data.marketCapSol);
  if (!Number.isFinite(marketCapSol) || marketCapSol <= 0) return;

  position.currentMarketCapSol = marketCapSol;
  position.lastTradeAt = Date.now();

  const entry = Number(position.entryMarketCapSol);
  if (!Number.isFinite(entry) || entry <= 0) {
    position.status = "TP_SL_NOT_ARMED";
    await savePosition(position);
    return;
  }

  const changePercent = ((marketCapSol / entry) - 1) * 100;
  position.changePercent = Number(changePercent.toFixed(2));
  await savePosition(position);

  console.log(
    "POSITION UPDATE:",
    position.symbol || mint,
    "market cap:", marketCapSol,
    "SOL, P/L estimate:", position.changePercent + "%"
  );

  const takeProfit = Number(config.takeProfitPercent ?? 50);
  const stopLoss = Number(config.stopLossPercent ?? 10);
  const hitTP = Number.isFinite(takeProfit) && takeProfit > 0 && changePercent >= takeProfit;
  const hitSL = Number.isFinite(stopLoss) && stopLoss > 0 && changePercent <= -stopLoss;

  if ((hitTP || hitSL) && !exiting.has(mint)) {
    console.log("AUTOMATIC EXIT TRIGGER:", hitTP ? "TAKE PROFIT" : "STOP LOSS", position.symbol || mint);
    await sellTrackedPosition(mint);
  }
}

async function restoreSavedPositions() {
  try {
    const state = await request("/api/state");
    const savedPositions = state && state.positions;

    if (!savedPositions || typeof savedPositions !== "object") {
      console.log("No saved positions found on server.");
      return;
    }

    let restored = 0;

    for (const [mint, position] of Object.entries(savedPositions)) {
      if (!position || position.mint !== mint) continue;

      if (!positions.has(mint)) {
        positions.set(mint, position);
        restored++;
      }
    }

    console.log("Saved positions restored:", restored);
  } catch (error) {
    console.error("Position restore failed:", error.message);
  }
}

async function connect() {
  if (connecting) return;
  connecting = true;

  try {
    await loadConfig();
    await restoreSavedPositions();
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
    if (!process.env.PUMPPORTAL_API_KEY) {
      console.log("TP/SL trades feed requires PUMPPORTAL_API_KEY in .env; real buys remain blocked.");
    }
    for (const mint of positions.keys()) subscribePositionTrades(mint);
  });

  ws.on("message", async raw => {
    try {
      const data = JSON.parse(raw.toString());
      await loadConfig();
      if (data && (data.txType === "buy" || data.txType === "sell") && data.mint) {
        await handleTradeUpdate(data);
        return;
      }
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
  let position = positions.get(mint);

  // Recover a persisted position if the bot restarted.
  if (!position) {
    try {
      const state = await request("/api/state");
      const saved = state && state.positions && state.positions[mint];

      if (saved && saved.mint === mint) {
        positions.set(mint, saved);
        position = saved;
        console.log("Restored saved position for SELL:", saved.symbol || mint);
      }
    } catch (error) {
      console.error("Could not restore position for SELL:", error.message);
    }
  }

  if (!position) {
    console.log("SELL skipped: no tracked position for", mint);
    return { ok: false, reason: "Position not found" };
  }

  if (exiting.has(mint)) {
    console.log("SELL skipped: exit already in progress for", mint);
    return { ok: false, reason: "Exit already in progress" };
  }

  if (position.simulated === true) {
    if (exiting.has(mint)) {
      return { ok: false, reason: "Exit already in progress" };
    }

    exiting.add(mint);
    try {
      console.log("PAPER SELL:", position.symbol || mint, "| simulated exit");
      positions.delete(mint);
      const timer = exitTimers.get(mint);
      if (timer) clearTimeout(timer);
      exitTimers.delete(mint);
      await request(`/api/position/${encodeURIComponent(mint)}`, "DELETE");
      return { ok: true, confirmed: true, simulated: true };
    } finally {
      exiting.delete(mint);
    }
  }

  if (config.realSell !== true || process.env.ALLOW_REAL_TRADING !== "YES") {
    console.log("SELL blocked: real-sell safety switches are OFF.");
    return { ok: false, reason: "Safety switches are OFF" };
  }

  exiting.add(mint);
  try {
    console.log("SELL requested for", position.symbol || mint);

    const result = await trader.sellToken(
      mint,
      Number(config.sellSlippagePercent ?? 1),
      true
    );

    if (result?.ok === true && result?.confirmed === true) {
      positions.delete(mint);
      const timer = exitTimers.get(mint);
      if (timer) clearTimeout(timer);
      exitTimers.delete(mint);
      await request(`/api/position/${encodeURIComponent(mint)}`, "DELETE");
      console.log("SELL CONFIRMED:", result.signature);
      return result;
    }

    console.log("SELL not confirmed; position retained.", result);
    return result;
  } catch (error) {
    console.error("SELL FAILED:", mint, error.message);
    return { ok: false, error: error.message };
  } finally {
    exiting.delete(mint);
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
