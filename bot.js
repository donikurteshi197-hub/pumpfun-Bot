
"use strict";

require("dotenv").config();

const WebSocket = require("ws");
const http = require("http");
const trader = require("./trader.js");
const { Connection, PublicKey } = require("@solana/web3.js");

const RPC_URL = process.env.RPC_URL;
const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_PROGRAM = new PublicKey(PUMP_PROGRAM_ID);
const onchainSeen = new Set();
let onChainConnection = null;
let onchainListenerStarted = false;

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
const priceMonitorTimers = new Map();
const priceMonitorBusy = new Set();
const priceMonitorLastError = new Map();

// Serialize Mayhem checks to reduce RPC bursts and HTTP 429 errors.
let mayhemCheckQueue = Promise.resolve();

function inspectTokenQueued(mint) {
  const task = mayhemCheckQueue.then(() => trader.inspectToken(mint));
  mayhemCheckQueue = task.catch(() => {});
  return task;
}

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
  const priceTimer = priceMonitorTimers.get(mint);
  if (priceTimer) clearInterval(priceTimer);
  priceMonitorTimers.delete(mint);
  priceMonitorBusy.delete(mint);
  priceMonitorLastError.delete(mint);
  positions.delete(mint);
  try {
    await request(`/api/position/${encodeURIComponent(mint)}`, "DELETE");
  } catch (e) {
    console.log("Position cleanup failed:", e.message);
  }
}

async function getSolUsd() {
  const response = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
    { signal: AbortSignal.timeout(5000) }
  );

  if (!response.ok) {
    throw new Error(`SOL price API failed: HTTP ${response.status}`);
  }

  const data = await response.json();
  const price = Number(data?.solana?.usd);

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("SOL price API returned an invalid price");
  }

  return price;
}

async function amountSol() {
  const usd = Number(config.amountUsd);

  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error("BUY BLOCKED: amountUsd must be greater than zero");
  }

  const solPrice = await getSolUsd();
  const sol = usd / solPrice;

  if (!Number.isFinite(sol) || sol <= 0) {
    throw new Error("BUY BLOCKED: USD to SOL conversion failed");
  }

  console.log(
    `BUY AMOUNT: $${usd.toFixed(2)} / SOL $${solPrice.toFixed(2)} = ${sol.toFixed(8)} SOL`
  );

  return sol;
}

async function buyNewToken(data) {
  const mint = data.mint;
  if (!mint || processing.has(mint) || seen.has(mint)) return;
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
  void dashboardToken(token);

  if (!botRunning || config.newTokens === false) {
    console.log("BUY SKIPPED: botRunning =", botRunning, "| newTokens =", config.newTokens);
    return;
  }

  // MAYHEM-ONLY FILTER: retry transient RPC/bonding-curve errors.
  let mayhemState = null;
  let mayhemError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      mayhemState = await inspectTokenQueued(mint);
      mayhemError = null;
      break;
    } catch (error) {
      mayhemError = error;
      console.log(
        `MAYHEM CHECK RETRY ${attempt}/3:`,
        token.symbol, mint, "|", error.message
      );
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, attempt * 500));
      }
    }
  }

  if (mayhemError) {
    token.status = "SKIPPED_MAYHEM_UNCONFIRMED";
    await dashboardToken(token);
    console.log(
      "MAYHEM CHECK FAILED AFTER RETRIES; token skipped:",
      token.symbol, mint, "|", mayhemError.message
    );
    return;
  }

  if (mayhemState?.bondingCurve?.isMayhemMode !== true) {
    token.status = "SKIPPED_NON_MAYHEM";
    await dashboardToken(token);
    console.log("MAYHEM FILTER: ordinary token skipped:", token.symbol, mint);
    return;
  }

  console.log("MAYHEM FILTER: CONFIRMED", token.symbol, mint);

  const max = Math.max(1, Number(config.maxOpenPositions || 1));
  if (positions.size >= max) {
    console.log("Skipping token: maximum open positions reached");
    return;
  }

  // PAPER MODE: simulate a position without sending a blockchain transaction.
  if (config.paperTrading === true) {
    let entry = Number(data.marketCapSol);

    // Derive entry market cap for direct on-chain detections.
    if (!Number.isFinite(entry) || entry <= 0) {
      const curve = mayhemState?.bondingCurve;
      const quote = Number(curve?.virtualQuoteReserves?.toString?.() ?? curve?.virtualQuoteReserves);
      const tokens = Number(curve?.virtualTokenReserves?.toString?.() ?? curve?.virtualTokenReserves);
      const supply = Number(curve?.tokenTotalSupply?.toString?.() ?? curve?.tokenTotalSupply);

      if (
        Number.isFinite(quote) && quote > 0 &&
        Number.isFinite(tokens) && tokens > 0 &&
        Number.isFinite(supply) && supply > 0
      ) {
        entry = (quote / tokens) * supply / 1e9;
        if (Number.isFinite(entry) && entry > 0) {
          token.marketCapSol = entry;
          console.log("PAPER ENTRY: market cap derived from bonding curve:", entry.toFixed(6), "SOL");
          await dashboardToken(token);
        }
      }
    }

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
      investmentUsd: Number(config.amountUsd ?? 1),
      estimatedPnlUsd: 0,
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
      process.env.ALLOW_REAL_TRADING !== "YES") {
    console.log("BUY BLOCKED:", JSON.stringify({
      realBuy: config.realBuy === true,
      realSell: config.realSell === true,
      allowRealTrading: process.env.ALLOW_REAL_TRADING === "YES"
    }));
    return;
  }

  seen.add(mint);
  processing.add(mint);
  try {
    const sol = await amountSol();

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
  if (priceMonitorTimers.has(mint)) return;

  console.log("DIRECT ON-CHAIN TP/SL MONITOR:", mint);

  const pollPrice = async () => {
    if (!positions.has(mint)) {
      const timer = priceMonitorTimers.get(mint);
      if (timer) clearInterval(timer);
      priceMonitorTimers.delete(mint);
      return;
    }

    if (priceMonitorBusy.has(mint)) return;
    priceMonitorBusy.add(mint);

    try {
      const marketCapSol = await trader.getTokenMarketCapSol(mint);
      priceMonitorLastError.delete(mint);
      await handleTradeUpdate({ mint, marketCapSol });
    } catch (error) {
      const now = Date.now();
      const last = priceMonitorLastError.get(mint) || 0;
      if (now - last >= 15000) {
        console.log(
          "DIRECT PRICE TEMPORARILY UNAVAILABLE:",
          mint,
          error.message
        );
        priceMonitorLastError.set(mint, now);
      }
    } finally {
      priceMonitorBusy.delete(mint);
    }
  };

  pollPrice();
  const timer = setInterval(pollPrice, 2000);
  priceMonitorTimers.set(mint, timer);
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

  // Paper P/L estimate based on market-cap movement, not an execution price.
  const investmentUsd = Number(position.investmentUsd ?? config.amountUsd ?? 1);
  const estimatedPnlUsd = investmentUsd * changePercent / 100;
  position.estimatedPnlUsd = Number(estimatedPnlUsd.toFixed(4));
  await savePosition(position);

  console.log(
    "POSITION UPDATE:",
    position.symbol || mint,
    "market cap:", marketCapSol,
    "SOL, P/L estimate:", position.changePercent + "%",
    "($" + position.estimatedPnlUsd.toFixed(2) + ")"
  );

  let hitTP = false;
  let hitSL = false;

  if (position.simulated === true) {
    const targetProfitUsd = Number(config.targetProfitUsd ?? 0.50);
    const stopLossUsd = Number(config.stopLossUsd ?? 0.10);
    hitTP = Number.isFinite(targetProfitUsd) && targetProfitUsd > 0 && estimatedPnlUsd >= targetProfitUsd;
    hitSL = Number.isFinite(stopLossUsd) && stopLossUsd > 0 && estimatedPnlUsd <= -stopLossUsd;
  } else {
    const takeProfit = Number(config.takeProfitPercent ?? 50);
    const stopLoss = Number(config.stopLossPercent ?? 10);
    hitTP = Number.isFinite(takeProfit) && takeProfit > 0 && changePercent >= takeProfit;
    hitSL = Number.isFinite(stopLoss) && stopLoss > 0 && changePercent <= -stopLoss;
  }

  if ((hitTP || hitSL) && !exiting.has(mint)) {
    console.log(
      "AUTOMATIC EXIT TRIGGER:",
      hitTP ? "TAKE PROFIT" : "STOP LOSS",
      position.symbol || mint,
      position.simulated === true
        ? "estimated P/L: $" + estimatedPnlUsd.toFixed(2)
        : "change: " + changePercent.toFixed(2) + "%"
    );
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


async function inspectOnChainCreation(event) {
  const signature = event?.signature;
  if (!signature || onchainSeen.has(signature)) return;

  onchainSeen.add(signature);
  if (onchainSeen.size > 5000) {
    onchainSeen.delete(onchainSeen.values().next().value);
  }

  if (event.err) return;
  if (!event.logs?.some(line => /Instruction:\s*Create(?:V2)?\b/i.test(line))) return;

  try {
    const tx = await onChainConnection.getParsedTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 1
    });

    if (!tx || tx.meta?.err) return;

    const instructions = [
      ...(tx.transaction.message.instructions || []),
      ...(tx.meta.innerInstructions || []).flatMap(group => group.instructions || [])
    ];

    for (const ix of instructions) {
      if (String(ix.programId) !== PUMP_PROGRAM_ID) continue;

      const firstAccount = ix.accounts?.[0];
      const mint = firstAccount?.toBase58
        ? firstAccount.toBase58()
        : String(firstAccount || "");

      if (!mint) continue;

      try {
        new PublicKey(mint);
      } catch {
        continue;
      }

      console.log("ON-CHAIN PUMP.FUN CREATE:", mint);
      console.log("CREATE SIGNATURE:", signature);

      // Skaneri zbulon tokenin; marketCap nuk shpiket.
      // PumpPortal mund të sjellë më pas të dhënat e tregut.
      // PumpPortal supplies token metadata to buyNewToken().
      // Do not process the same creation twice from the on-chain listener.
      console.log("DIRECT ON-CHAIN DETECTION:", mint);
      await buyNewToken({
        mint,
        signature,
        name: "Mayhem token",
        symbol: mint.slice(0, 6),
        marketCapSol: null
      });
      return;
    }
  } catch (error) {
    console.log("On-chain transaction lookup failed:", error.message);
  }
}

async function startOnChainScanner() {
  if (onchainListenerStarted) return;

  if (!RPC_URL) {
    console.log("ON-CHAIN SCANNER OFF: RPC_URL mungon në .env");
    return;
  }

  try {
    const wsEndpoint = RPC_URL
      .replace(/^https:/, "wss:")
      .replace(/^http:/, "ws:");

    onChainConnection = new Connection(RPC_URL, {
      commitment: "confirmed",
      wsEndpoint
    });

    await onChainConnection.onLogs(
      PUMP_PROGRAM,
      event => { void inspectOnChainCreation(event); },
      "confirmed"
    );

    onchainListenerStarted = true;
    console.log("ON-CHAIN SCANNER: listening to Pump.fun program.");
    console.log("ON-CHAIN MODE: direct token detection enabled.");
  } catch (error) {
    console.log("ON-CHAIN SCANNER START FAILED:", error.message);
  }
}

// CONFIG_AUTO_REFRESH: keep dashboard START/STOP synchronized with the bot.
setInterval(() => {
  loadConfig().catch(error => {
    console.log("CONFIG REFRESH FAILED:", error.message);
  });
}, 1000);

async function connect() {
  if (connecting || onchainListenerStarted) return;
  connecting = true;

  try {
    await loadConfig();
    await restoreSavedPositions();
    await startOnChainScanner();
  } catch (e) {
    console.log("DIRECT SOLANA START ERROR:", e.message);
  }

  connecting = false;

  if (onchainListenerStarted) {
    console.log("DIRECT SOLANA MODE: PumpPortal WebSocket disabled.");
    console.log("Mayhem-only filter remains enabled.");
  } else {
    console.log("DIRECT SOLANA MODE NOT READY: check RPC_URL in .env");
    scheduleReconnect();
  }
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
      console.log(
        "PAPER SELL:", position.symbol || mint,
        "| estimated P/L: $" + Number(position.estimatedPnlUsd ?? 0).toFixed(2),
        "| simulated exit only"
      );
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
