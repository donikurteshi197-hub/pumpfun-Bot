require("dotenv").config();

const { Connection, PublicKey } = require("@solana/web3.js");
const { OnlinePumpSdk } = require("@pump-fun/pump-sdk");

const connection = new Connection(
  process.env.RPC_URL,
  "confirmed"
);

const sdk = new OnlinePumpSdk(connection);

console.log("================================");
console.log("PUMP.FUN PAPER BOT");
console.log("MODE: SIMULATION ONLY");
console.log("REAL TRADES: OFF");
console.log("================================");

async function test() {
  try {
    const global = await sdk.fetchGlobal();

    console.log("Pump.fun connection: OK");
    console.log("Global state: OK");
    console.log("Paper bot: READY");

    console.log("");
    console.log("No trade was executed.");
    console.log("No SOL was spent.");
  } catch (error) {
    console.log("ERROR:", error.message);
  }
}

test();
