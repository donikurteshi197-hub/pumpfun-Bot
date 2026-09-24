const fs = require("fs");
const { Keypair } = require("@solana/web3.js");

const keypair = Keypair.generate();

fs.writeFileSync(
  ".bot-wallet.json",
  JSON.stringify(Array.from(keypair.secretKey))
);

console.log("Wallet created!");
console.log("Address:", keypair.publicKey.toBase58());