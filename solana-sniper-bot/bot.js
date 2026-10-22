"use strict";

require("dotenv").config();

const { PublicKey } = require("@solana/web3.js");
const { PUMP_SDK, PUMP_PROGRAM_ID } = require("@pump-fun/pump-sdk");
const { createTrader } = require("./trader");

const CREATE_EVENT_DISCRIMINATOR = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);
const seenMints = new Set();
const inFlight = new Set();

function log(message, level = "info") {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()}: ${message}`;
  console.log(line);
}

function parseCreateEvents(logs) {
  const events = [];
  for (const line of logs || []) {
    if (!line.startsWith("Program data: ")) continue;

    try {
      const data = Buffer.from(line.slice("Program data: ".length).trim(), "base64");
      if (data.length < 9 || !data.subarray(0, 8).equals(CREATE_EVENT_DISCRIMINATOR)) continue;

      const event = PUMP_SDK.decodeCreateEventBc(data.subarray(8));
      if (event?.mint) events.push(event);
    } catch {
      // Other program data is ignored.
    }
  }
  return events;
}

async function main() {
  const cfgPath = require("path").join(__dirname, "runtime-config.json");
  const fs = require("fs");

  const readConfig = () => {
    try { return JSON.parse(fs.readFileSync(cfgPath, "utf8")); }
    catch { return {}; }
  };

  const rpc = process.env.RPC_URL;
  if (!rpc) throw new Error("Mungon RPC_URL në .env.");

  const trader = createTrader();
  const { connection } = trader;

  log(`WALLET: ${trader.wallet.publicKey.toBase58()}`);
  log(`PUMP PROGRAM: ${PUMP_PROGRAM_ID.toBase58()}`);
  log("MODE: Mayhem Mode only; bonding-curve trades only; no migration/AMM buys.");
  log(`LIVE TRADING: ${readConfig().liveTrading === true && process.env.ALLOW_REAL_TRADING === "YES" ? "ON" : "OFF"}`);

  const subscription = connection.onLogs(
    PUMP_PROGRAM_ID,
    async (entry) => {
      if (entry.err) return;

      const events = parseCreateEvents(entry.logs);
      for (const event of events) {
        if (event.isMayhemMode !== true) continue;

        let mint;
        try { mint = new PublicKey(event.mint); }
        catch { continue; }

        const key = mint.toBase58();
        if (seenMints.has(key) || inFlight.has(key)) continue;

        inFlight.add(key);

        log(`MAYHEM CREATE DETECTED: ${event.symbol || event.name || key} | ${key}`);

        try {
          const cfg = readConfig();
          if (cfg.running !== true) {
            log(`Bot është STOP: tokeni u zbulua, por nuk blihet: ${key}`);
            continue;
          }

          const positions = (() => {
            try {
              return JSON.parse(fs.readFileSync(require("path").join(__dirname, "data", "positions.json"), "utf8"));
            } catch { return []; }
          })();

          const openCount = positions.filter(p => p.status === "open").length;
          if (openCount >= Number(cfg.maxOpenPositions ?? 3)) {
            log(`MAX OPEN POSITIONS: nuk blihet ${key}`);
            continue;
          }

          const result = await trader.buyToken(event, mint);
          seenMints.add(key);
          if (result?.simulated) {
            log(`BUY SIMULATION ONLY: ${key} | amount=${result.tokenAmount} | SOL lamports=${result.solAmount}`);
          }
        } catch (e) {
          log(`BUY ERROR ${key}: ${e.message}`, "error");
        } finally {
          inFlight.delete(key);
        }
      }
    },
    "processed"
  );

  log(`PUMP LOG SUBSCRIPTION READY: ${subscription}`);

  const monitor = setInterval(async () => {
    try {
      if (readConfig().running === true) await trader.refreshPositions();
    } catch (e) {
      log(`MONITOR ERROR: ${e.message}`, "error");
    }
  }, 5000);

  const shutdown = async () => {
    clearInterval(monitor);
    try { await connection.removeOnLogsListener(subscription); } catch {}
    log("Bot stopped.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(e => {
  log(`STARTUP ERROR: ${e.stack || e.message}`, "error");
  process.exit(1);
});
