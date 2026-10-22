"use strict";

const fs = require("fs");
const { Keypair } = require("@solana/web3.js");
const bs58pkg = require("bs58");
const bs58 = bs58pkg.default || bs58pkg;

const file = ".bot-wallet.json";

if (fs.existsSync(file)) {
  console.log("Wallet-i ekziston tashmë. Nuk u ndryshua.");
  process.exit(0);
}

const wallet = Keypair.generate();

fs.writeFileSync(
  file,
  JSON.stringify(Array.from(wallet.secretKey)),
  { mode: 0o600, flag: "wx" }
);

try {
  fs.chmodSync(file, 0o600);
} catch {}

console.log("Wallet i ri u krijua.");
console.log("Adresa publike:", wallet.publicKey.toBase58());
console.log("Çelësi privat nuk shfaqet.");
console.log("Ruaje wallet-in në mënyrë të sigurt; mos e fshi skedarin.");
