require("dotenv").config();

const {
  Connection,
  PublicKey
} = require("@solana/web3.js");

const {
  PUMP_PROGRAM_ID,
  PumpSdk
} = require("@pump-fun/pump-sdk");

const connection = new Connection(
  process.env.RPC_URL,
  "processed"
);

const sdk = new PumpSdk();

console.log("================================");
console.log("PUMP.FUN FAST TOKEN SNIPER");
console.log("MODE: PAPER ONLY");
console.log("================================");
console.log("Listening for NEW TOKEN CREATIONS...");
console.log("");

const seen = new Set();

let totalTokens = 0;

connection.onLogs(
  new PublicKey(PUMP_PROGRAM_ID),
  async (logs) => {

    if (!logs || !logs.logs) return;

    if (seen.has(logs.signature)) return;

    const programDataLogs = logs.logs.filter(
      (log) => log.startsWith("Program data:")
    );

    if (programDataLogs.length === 0) return;

    for (const log of programDataLogs) {

      try {

        const base64 = log.replace(
          "Program data: ",
          ""
        );

        const data = Buffer.from(
          base64,
          "base64"
        );

        const event = sdk.decodeCreateEventBc(data);

        if (!event) continue;

        seen.add(logs.signature);

        totalTokens++;

        const detectedAt = Date.now();

        let age = "?";

        if (event.timestamp) {

          const timestamp =
            Number(event.timestamp.toString()) * 1000;

          age =
            ((detectedAt - timestamp) / 1000).toFixed(2);
        }

        console.log("");
        console.log("--------------------------------");
        console.log("🆕 NEW TOKEN");
        console.log("--------------------------------");

        console.log(
          "Name:",
          event.name || "N/A"
        );

        console.log(
          "Symbol:",
          event.symbol || "N/A"
        );

        console.log(
          "Mint:",
          event.mint
            ? event.mint.toBase58()
            : "N/A"
        );

        console.log(
          "Creator:",
          event.creator
            ? event.creator.toBase58()
            : "N/A"
        );

        console.log(
          "Age:",
          age,
          "seconds"
        );

        console.log(
          "Mayhem:",
          event.isMayhemMode === true
            ? "YES"
            : "NO"
        );

        console.log(
          "Signature:",
          logs.signature
        );

        console.log(
          "Total detected:",
          totalTokens
        );

        console.log("--------------------------------");
        console.log("PAPER BUY: OFF");
        console.log("PAPER SELL: OFF");
        console.log("REAL BUY: OFF");
        console.log("REAL SELL: OFF");
        console.log("--------------------------------");

        break;

      } catch (error) {

        // Program data tjetër, jo CreateEvent.
      }
    }
  },
  "processed"
);

console.log("FAST SCANNER: READY");
console.log("Real BUY: OFF");
console.log("Real SELL: OFF");
