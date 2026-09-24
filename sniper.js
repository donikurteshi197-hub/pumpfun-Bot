require("dotenv").config();

const {
  Connection,
  PublicKey
} = require("@solana/web3.js");

const {
  PUMP_PROGRAM_ID
} = require("@pump-fun/pump-sdk");

const config = require("./config");

const connection = new Connection(
  process.env.RPC_URL,
  "confirmed"
);

console.log("================================");
console.log("PUMP.FUN SNIPER");
console.log("================================");

console.log("Mode:", config.MODE);
console.log("Trade amount:", config.TRADE_AMOUNT_SOL, "SOL");
console.log("Take profit:", config.TAKE_PROFIT_PERCENT + "%");
console.log("Stop loss:", config.STOP_LOSS_PERCENT + "%");
console.log("Max hold:", config.MAX_HOLD_SECONDS, "seconds");
console.log("================================");

let openPositions = 0;
let dailyTrades = 0;

const seen = new Set();

connection.onLogs(
  new PublicKey(PUMP_PROGRAM_ID),
  async (logs) => {
    if (!logs || !logs.logs) return;

    const programData = logs.logs.find(
      (log) => log.startsWith("Program data:")
    );

    if (!programData) return;

    if (seen.has(logs.signature)) return;
    seen.add(logs.signature);

    if (
      openPositions >= config.MAX_OPEN_POSITIONS
    ) {
      return;
    }

    if (
      dailyTrades >= config.MAX_DAILY_TRADES
    ) {
      return;
    }

    openPositions++;
    dailyTrades++;

    const time = new Date().toISOString();

    console.log("");
    console.log("================================");
    console.log("🆕 NEW TOKEN DETECTED");
    console.log("================================");
    console.log("Signature:", logs.signature);
    console.log("Time:", time);
    console.log(
      "Paper BUY:",
      config.TRADE_AMOUNT_SOL,
      "SOL"
    );
    console.log(
      "TP:",
      "+" + config.TAKE_PROFIT_PERCENT + "%"
    );
    console.log(
      "SL:",
      "-" + config.STOP_LOSS_PERCENT + "%"
    );
    console.log(
      "Max hold:",
      config.MAX_HOLD_SECONDS,
      "seconds"
    );
    console.log("================================");

    console.log("Waiting for paper position to finish...");

    setTimeout(() => {
      openPositions--;

      console.log("");
      console.log("⏱️ PAPER TIME STOP");
      console.log(
        "Position closed after",
        config.MAX_HOLD_SECONDS,
        "seconds"
      );
      console.log("Real SOL spent: 0");
      console.log("================================");
    }, config.MAX_HOLD_SECONDS * 1000);
  },
  "confirmed"
);

console.log("Scanner: READY");
console.log("Real BUY: OFF");
console.log("Real SELL: OFF");
console.log("Listening for new Pump.fun activity...");
