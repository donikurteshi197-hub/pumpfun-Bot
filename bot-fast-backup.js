require("dotenv").config();

const WebSocket = require("ws");

console.log("================================");
console.log("PUMP.FUN FAST TOKEN SNIPER");
console.log("MODE: PAPER ONLY");
console.log("================================");
console.log("");
console.log("Connecting to Pump.fun realtime feed...");

const WS_URL = "wss://pumpportal.fun/api/data";

let ws;
let reconnectTimer;

function connect() {
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    console.log("");
    console.log("CONNECTED: YES");

    ws.send(
      JSON.stringify({
        method: "subscribeNewToken"
      })
    );

    console.log("Subscribed: NEW TOKEN CREATIONS");
    console.log("");
    console.log("Listening for NEW TOKEN CREATIONS...");
    console.log("");
    console.log("FAST SCANNER: READY");
    console.log("Real BUY: OFF");
    console.log("Real SELL: OFF");
    console.log("--------------------------------");
  });

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (!data.mint) return;

      console.log("");
      console.log("========== 🆕 NEW TOKEN ==========");
      console.log("Name:              ", data.name || "N/A");
      console.log("Symbol:            ", data.symbol || "N/A");
      console.log("Mint:              ", data.mint);
      console.log("Creator:           ", data.traderPublicKey || "N/A");
      console.log("Signature:         ", data.signature || "N/A");
      console.log("TX Type:           ", data.txType || "N/A");

      console.log("--------------------------------");
      console.log("Initial Buy:       ", data.initialBuy ?? "N/A");
      console.log(
        "Market Cap:        ",
        data.marketCapSol ?? "N/A",
        "SOL"
      );
      console.log(
        "vSOL Curve:        ",
        data.vSolInBondingCurve ?? "N/A"
      );
      console.log(
        "vTokens Curve:     ",
        data.vTokensInBondingCurve ?? "N/A"
      );
      console.log(
        "Bonding Curve:     ",
        data.bondingCurveKey || "N/A"
      );

      console.log("--------------------------------");
      console.log("PAPER ONLY: NO BUY");
      console.log("================================");
    } catch (error) {
      console.log("Message parse error:", error.message);
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

connect();
