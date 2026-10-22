"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const bs58pkg = require("bs58");
const bs58 = bs58pkg.default || bs58pkg;

const {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  ComputeBudgetProgram,
} = require("@solana/web3.js");

const {
  OnlinePumpSdk,
  PUMP_SDK,
  PUMP_PROGRAM_ID,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
} = require("@pump-fun/pump-sdk");

const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } =
  require("@solana/spl-token");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const POSITIONS_FILE = path.join(DATA_DIR, "positions.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function log(message, level = "info") {
  const entry = { time: new Date().toISOString(), level, message };
  console.log(`[${entry.time}] ${level.toUpperCase()}: ${message}`);
  const history = readJson(HISTORY_FILE, []);
  history.unshift(entry);
  writeJson(HISTORY_FILE, history.slice(0, 200));
}

function loadWallet() {
  if (process.env.WALLET_PRIVATE_KEY) {
    const raw = process.env.WALLET_PRIVATE_KEY.trim();
    try {
      const arr = raw.startsWith("[") ? JSON.parse(raw) : bs58.decode(raw);
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    } catch (e) {
      throw new Error("WALLET_PRIVATE_KEY nuk mund të lexohet; kontrollo formatin pa e publikuar.");
    }
  }

  const file = path.join(ROOT, ".bot-wallet.json");
  if (!fs.existsSync(file)) {
    throw new Error("Mungon WALLET_PRIVATE_KEY dhe .bot-wallet.json.");
  }

  const obj = JSON.parse(fs.readFileSync(file, "utf8"));
  const secret = Array.isArray(obj)
    ? obj
    : obj.secretKey || obj.privateKey || obj.secret_key;

  if (!secret) throw new Error(".bot-wallet.json nuk përmban secretKey të njohur.");
  if (Array.isArray(secret)) return Keypair.fromSecretKey(Uint8Array.from(secret));
  return Keypair.fromSecretKey(Uint8Array.from(bs58.decode(secret)));
}

const EXPECTED_WALLET_ADDRESS = "HdSbyvbdz3HA9LdNpUgKbwCtmbzrgJUdbx9iyEiSBvyX";

function assertExpectedWallet(wallet) {
  const actual = wallet.publicKey.toBase58();
  if (actual !== EXPECTED_WALLET_ADDRESS) {
    throw new Error(
      `Wallet mismatch: pritej ${EXPECTED_WALLET_ADDRESS}, u ngarkua ${actual}. Tregtimi nuk duhet të vazhdojë.`
    );
  }
}

function getConfig() {
  return readJson(path.join(ROOT, "runtime-config.json"), {});
}

function getPositions() {
  return readJson(POSITIONS_FILE, []);
}

function savePositions(positions) {
  writeJson(POSITIONS_FILE, positions);
}

function isLiveEnabled() {
  const cfg = getConfig();
  return cfg.liveTrading === true && process.env.ALLOW_REAL_TRADING === "YES";
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function bnNumber(value) {
  return Number(value?.toString?.() ?? value ?? 0);
}

function quoteMintOf(event) {
  const { NATIVE_MINT } = require("@solana/spl-token");
  const quoteMint = event.quoteMint instanceof PublicKey
    ? event.quoteMint
    : new PublicKey(event.quoteMint);

  // Pump.fun legacy SOL curves store quoteMint as PublicKey.default.
  return quoteMint.equals(PublicKey.default) ? NATIVE_MINT : quoteMint;
}

function mayhemEventIsSolQuoted(event) {
  const { NATIVE_MINT } = require("@solana/spl-token");
  return quoteMintOf(event).equals(NATIVE_MINT);
}

function createTrader() {
  const rpc = process.env.RPC_URL;
  if (!rpc) throw new Error("Mungon RPC_URL në .env.");

  const connection = new Connection(rpc, {
    commitment: "processed",
    confirmTransactionInitialTimeout: 15000,
  });

  const wallet = loadWallet();
  assertExpectedWallet(wallet);
  const sdk = new OnlinePumpSdk(connection);

  async function sendInstructions(instructions) {
    if (!isLiveEnabled()) {
      throw new Error("LIVE OFF: aktivizohet vetëm kur runtime-config.json ka liveTrading=true dhe ALLOW_REAL_TRADING=YES.");
    }

    const latest = await connection.getLatestBlockhash("processed");
    const tx = new Transaction({
      feePayer: wallet.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    });

    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 350000 }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: Number(process.env.PRIORITY_FEE_MICROLAMPORTS || 50000),
      }),
      ...instructions
    );

    tx.sign(wallet);
    const raw = tx.serialize();
    const signature = await connection.sendRawTransaction(raw, {
      skipPreflight: true,
      maxRetries: 0,
      preflightCommitment: "processed",
    });

    log(`TRANSAKSIONI U DËRGUA: ${signature}`);
    return signature;
  }

  async function buyToken(event, mint) {
    const cfg = getConfig();
    const amountSol = Number(cfg.buyAmountSol ?? 0.01);
    const slippage = Number(cfg.slippagePercent ?? 20);

    if (!Number.isFinite(amountSol) || amountSol <= 0)
      throw new Error("buyAmountSol nuk është i vlefshëm.");
    if (!Number.isFinite(slippage) || slippage < 0 || slippage > 100)
      throw new Error("slippagePercent duhet të jetë nga 0 deri në 100.");
    if (event.isMayhemMode !== true)
      throw new Error("Refuzohet: eventi nuk është Mayhem Mode.");
    if (!mayhemEventIsSolQuoted(event))
      throw new Error("Ky version pranon vetëm Mayhem të kuotuar në SOL.");

    for (const field of [
      "creator", "virtualTokenReserves", "virtualQuoteReserves",
      "realTokenReserves", "tokenTotalSupply", "creatorFeeBps"
    ]) {
      if (event[field] == null)
        throw new Error(`CreateEvent nuk përmban ${field}.`);
    }

    const tokenProgram = event.tokenProgram
      ? new PublicKey(event.tokenProgram)
      : TOKEN_2022_PROGRAM_ID;
    const quoteMint = quoteMintOf(event);

    // Nuk thërrasim fetchBuyState() për tokenin e ri.
    const [global, feeConfig] = await Promise.all([
      sdk.fetchGlobal(),
      sdk.fetchFeeConfig(),
    ]);

    const recipients = [
      global.reservedFeeRecipient,
      ...(global.reservedFeeRecipients || []),
    ].filter(Boolean).map(x => new PublicKey(x));

    if (!recipients.length)
      throw new Error("Mungojnë reserved fee recipients për Mayhem.");

    const feeRecipient =
      recipients[Math.floor(Math.random() * recipients.length)];

    const BN = require("bn.js");
    const lamports = BigInt(Math.floor(amountSol * 1e9));
    const solAmount = new BN(lamports.toString());

    // Përdor rezervat e CreateEvent, jo lexim të ri të bonding curve nga RPC.
    const eventCurve = {
      virtualTokenReserves: event.virtualTokenReserves,
      virtualQuoteReserves: event.virtualQuoteReserves,
      realTokenReserves: event.realTokenReserves,
      tokenTotalSupply: event.tokenTotalSupply,
      creator: new PublicKey(event.creator),
      isMayhemMode: true,
      quoteMint,
      creatorFeeBps: event.creatorFeeBps,
    };

    const amount = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: event.tokenTotalSupply,
      bondingCurve: eventCurve,
      amount: solAmount,
      quoteMint,
      creatorFeeBps: event.creatorFeeBps,
    });

    if (!amount || amount.lten(0))
      throw new Error("CreateEvent nuk dha sasi të vlefshme tokenësh.");

    const spl = require("@solana/spl-token");
    const ata = spl.getAssociatedTokenAddressSync(
      mint, wallet.publicKey, false, tokenProgram
    );
    const createAtaIx =
      spl.createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey, ata, wallet.publicKey, mint, tokenProgram
      );

    const quoteWithSlippage = solAmount.add(
      solAmount.mul(new BN(Math.floor(slippage * 10))).div(new BN(1000))
    );

    const buyIx = await PUMP_SDK.getBuyV2InstructionRaw({
      user: wallet.publicKey,
      mint,
      creator: new PublicKey(event.creator),
      amount,
      quoteAmount: quoteWithSlippage,
      feeRecipient,
      tokenProgram,
      quoteMint,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
    });

    log(`MAYHEM CREATE BUY PREPARED: ${event.symbol || mint.toBase58()} | live=${isLiveEnabled()}`);

    if (!isLiveEnabled()) {
      log("SIMULATION ONLY: transaksioni nuk u dërgua; LIVE OFF.");
      return {
        simulated: true,
        mint: mint.toBase58(),
        tokenAmount: amount.toString(),
        solAmount: lamports.toString(),
      };
    }

    const signature = await sendInstructions([createAtaIx, buyIx]);
    const position = {
      mint: mint.toBase58(),
      name: event.name || "",
      symbol: event.symbol || "",
      signature,
      tokenProgram: tokenProgram.toBase58(),
      quoteMint: quoteMint.toBase58(),
      spentLamports: lamports.toString(),
      tokenAmount: amount.toString(),
      openedAt: Date.now(),
      status: "open",
      lastEstimatedSol: null,
      lastPnlPercent: null,
    };

    const positions = getPositions();
    positions.unshift(position);
    savePositions(positions.slice(0, 100));
    log(`BUY SENT: ${event.symbol || event.name || mint.toBase58()} | ${signature}`);
    return position;
  }

  async function sellToken(position, reason = "manual") {
    const mint = new PublicKey(position.mint);
    const tokenProgram = new PublicKey(position.tokenProgram);
    const cfg = getConfig();
    const slippage = Number(cfg.slippagePercent ?? 20);
    const BN = require("bn.js");

    const [state, global, feeConfig] = await Promise.all([
      sdk.fetchSellState(mint, wallet.publicKey, tokenProgram),
      sdk.fetchGlobal(),
      sdk.fetchFeeConfig(),
    ]);

    if (state.bondingCurve.isMayhemMode !== true) {
      throw new Error("Shitja u ndal: bonding curve nuk raporton Mayhem Mode.");
    }
    if (state.bondingCurve.complete) {
      throw new Error("Shitja në bonding curve u ndal: tokeni është graduar.");
    }

    const tokenAmount = new BN(position.tokenAmount);
    const expectedSol = getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: state.bondingCurve.tokenTotalSupply,
      bondingCurve: state.bondingCurve,
      amount: tokenAmount,
    });

    if (!expectedSol || expectedSol.lten(0)) {
      throw new Error("SDK ktheu kuotim shitjeje të pavlefshëm.");
    }

    const instructions = await PUMP_SDK.sellV2Instructions({
      global,
      ...state,
      mint,
      user: wallet.publicKey,
      amount: tokenAmount,
      quoteAmount: expectedSol,
      slippage,
      tokenProgram: state.tokenProgram || tokenProgram,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
    });

    if (!isLiveEnabled()) {
      log(`LIVE OFF: shitja nuk u dërgua për ${position.mint}; arsye=${reason}`);
      return null;
    }

    const signature = await sendInstructions(instructions);
    const positions = getPositions();
    const index = positions.findIndex(p => p.mint === position.mint && p.status === "open");
    if (index >= 0) {
      positions[index].status = "sell-sent";
      positions[index].sellSignature = signature;
      positions[index].sellReason = reason;
      positions[index].closedAt = Date.now();
      savePositions(positions);
    }
    log(`SELL SENT: ${position.mint} | arsye=${reason} | ${signature}`);
    return signature;
  }

  async function refreshPositions() {
    const cfg = getConfig();
    const positions = getPositions();
    const now = Date.now();
    let changed = false;

    for (const position of positions) {
      if (position.status !== "open") continue;

      try {
        const mint = new PublicKey(position.mint);
        const tokenProgram = new PublicKey(position.tokenProgram);
        const [state, global, feeConfig] = await Promise.all([
          sdk.fetchSellState(mint, wallet.publicKey, tokenProgram),
          sdk.fetchGlobal(),
          sdk.fetchFeeConfig(),
        ]);

        if (state.bondingCurve.complete || state.bondingCurve.isMayhemMode !== true) {
          position.status = "needs-attention";
          position.lastError = "Bonding curve është graduar ose nuk është Mayhem Mode.";
          changed = true;
          log(`POSITION NEEDS ATTENTION: ${position.mint} — nuk po tentohet shitje automatike në AMM.`);
          continue;
        }

        const BN = require("bn.js");
        const tokenAmount = new BN(position.tokenAmount);
        const quote = getSellSolAmountFromTokenAmount({
          global,
          feeConfig,
          mintSupply: state.bondingCurve.tokenTotalSupply,
          bondingCurve: state.bondingCurve,
          amount: tokenAmount,
        });

        const expectedLamports = bnNumber(quote);
        const spentLamports = Number(position.spentLamports);
        const pnl = spentLamports > 0
          ? ((expectedLamports - spentLamports) / spentLamports) * 100
          : 0;

        position.lastEstimatedSol = expectedLamports / 1e9;
        position.lastPnlPercent = pnl;
        position.lastCheckedAt = now;
        changed = true;

        const ageSeconds = (now - position.openedAt) / 1000;
        let reason = null;

        if (pnl >= Number(cfg.takeProfitPercent ?? 50)) reason = "take-profit";
        else if (pnl <= -Math.abs(Number(cfg.stopLossPercent ?? 10))) reason = "stop-loss";
        else if (ageSeconds >= Number(cfg.holdSeconds ?? 30)) reason = "hold-timer";

        if (reason) {
          log(`SELL TRIGGER: ${position.mint} | ${reason} | estimated PnL ${pnl.toFixed(2)}%`);
          try { await sellToken(position, reason); }
          catch (e) { log(`SELL ERROR ${position.mint}: ${e.message}`, "error"); }
        }
      } catch (e) {
        log(`POSITION CHECK ERROR ${position.mint}: ${e.message}`, "error");
      }
    }

    if (changed) savePositions(positions);
  }

  return { connection, wallet, sdk, buyToken, sellToken, refreshPositions, log };
}

module.exports = { createTrader, log };
