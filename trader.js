require("dotenv").config();

const fs = require("fs");
const {
  Connection,
  Keypair,
  PublicKey
} = require("@solana/web3.js");

const {
  OnlinePumpSdk,
  PumpSdk
} = require("@pump-fun/pump-sdk");

const RPC_URL = process.env.RPC_URL;

if (!RPC_URL) {
  throw new Error("RPC_URL missing from .env");
}

const secret = Uint8Array.from(
  JSON.parse(
    fs.readFileSync(".bot-wallet.json", "utf8")
  )
);

const wallet = Keypair.fromSecretKey(secret);

const connection = new Connection(
  RPC_URL,
  "confirmed"
);

const onlineSdk = new OnlinePumpSdk(connection);
const pumpSdk = new PumpSdk();

console.log("================================");
console.log("PUMP.FUN TRADER ENGINE");
console.log("================================");
console.log("SDK: READY");
console.log("RPC: READY");
console.log("Wallet:", wallet.publicKey.toBase58());
console.log("MODE: DRY RUN");
console.log("REAL BUY: OFF");
console.log("REAL SELL: OFF");
console.log("================================");

async function checkWallet() {
  const balance = await connection.getBalance(
    wallet.publicKey
  );

  console.log(
    "Wallet balance:",
    balance / 1e9,
    "SOL"
  );
}

async function inspectToken(mintAddress) {
  const mint = new PublicKey(mintAddress);

  console.log("");
  console.log("================================");
  console.log("TOKEN INSPECTION");
  console.log("Mint:", mint.toBase58());
  console.log("================================");

  const state = await onlineSdk.fetchBuyState(
    mint,
    wallet.publicKey
  );

  console.log(
    "Bonding curve:",
    state.bondingCurve
      ? "FOUND"
      : "NOT FOUND"
  );

  console.log(
    "User token account:",
    state.associatedUserAccountInfo
      ? "EXISTS"
      : "NOT CREATED"
  );

  console.log(
    "Buy state keys:",
    Object.keys(state)
  );

  return state;
}

module.exports = {
  wallet,
  connection,
  onlineSdk,
  pumpSdk,
  checkWallet,
  inspectToken
};

checkWallet().catch((error) => {
  console.error(
    "Trader initialization error:",
    error.message
  );
});
