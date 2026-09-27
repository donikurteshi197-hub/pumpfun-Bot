require("dotenv").config();

const fs = require("fs");
const {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage
} = require("@solana/web3.js");

const BN = require("bn.js");

const {
  OnlinePumpSdk,
  PumpSdk,
  getBuyTokenAmountFromSolAmount
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

/*
==================================================
SAFETY
==================================================
REAL BUY requires BOTH:

1. realBuy === true
2. ALLOW_REAL_TRADING=YES in .env

Default = OFF
==================================================
*/

const ALLOW_REAL_TRADING =
  process.env.ALLOW_REAL_TRADING === "YES";

console.log("================================");
console.log("PUMP.FUN TRADER ENGINE");
console.log("================================");
console.log("SDK: READY");
console.log("RPC: READY");
console.log(
  "Wallet:",
  wallet.publicKey.toBase58()
);
console.log(
  "ALLOW REAL TRADING:",
  ALLOW_REAL_TRADING ? "YES" : "NO"
);
console.log("REAL BUY: OFF");
console.log("REAL SELL: OFF");
console.log("================================");


/*
==================================================
WALLET
==================================================
*/

async function checkWallet() {
  const balance = await connection.getBalance(
    wallet.publicKey
  );

  console.log(
    "Wallet balance:",
    balance / 1e9,
    "SOL"
  );

  return balance;
}


/*
==================================================
TOKEN PROGRAM DETECTION
==================================================
*/

async function getTokenProgram(mint) {
  const accountInfo =
    await connection.getAccountInfo(mint);

  if (!accountInfo) {
    throw new Error(
      "Mint account not found: " +
      mint.toBase58()
    );
  }

  return accountInfo.owner;
}


/*
==================================================
TOKEN INSPECTION
==================================================
*/

async function inspectToken(mintAddress) {
  const mint = new PublicKey(mintAddress);

  let lastError;

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const state =
        await onlineSdk.fetchBuyState(
          mint,
          wallet.publicKey
        );

      const tokenProgram =
        await getTokenProgram(mint);

      console.log("");
      console.log("================================");
      console.log("TOKEN INSPECTION");
      console.log("================================");
      console.log("Mint:", mint.toBase58());

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
        "Quote mint:",
        state.quoteMint.toBase58()
      );

      console.log(
        "Quote token program:",
        state.quoteTokenProgram.toBase58()
      );

      console.log(
        "Base token program:",
        tokenProgram.toBase58()
      );

      console.log(
        "Mayhem mode:",
        state.bondingCurve.isMayhemMode
          ? "YES"
          : "NO"
      );

      console.log(
        "Inspection:",
        "SUCCESS"
      );

      console.log("================================");

      return {
        ...state,
        tokenProgram
      };

    } catch (error) {
      lastError = error;

      console.log(
        "Inspection attempt:",
        attempt,
        "failed:",
        error.message
      );

      if (attempt < 5) {
        await new Promise(resolve =>
          setTimeout(resolve, 100)
        );
      }
    }
  }

  throw lastError;
}


/*
==================================================
BUILD BUY TRANSACTION
==================================================
Does NOT send the transaction.
==================================================
*/

async function buildBuyTransaction(
  mintAddress,
  solAmount = 0.01,
  slippage = 0.20
) {
  const mint = new PublicKey(mintAddress);

  if (!Number.isFinite(solAmount) || solAmount <= 0) {
    throw new Error(
      "Invalid SOL amount"
    );
  }

  if (
    !Number.isFinite(slippage) ||
    slippage < 0 ||
    slippage > 0.99
  ) {
    throw new Error(
      "Invalid slippage"
    );
  }

  console.log("");
  console.log("================================");
  console.log("BUILD BUY TRANSACTION");
  console.log("================================");
  console.log("Mint:", mint.toBase58());
  console.log(
    "SOL amount:",
    solAmount
  );
  console.log(
    "Slippage:",
    slippage
  );

  const lamports = Math.floor(
    solAmount * 1_000_000_000
  );

  if (lamports <= 0) {
    throw new Error(
      "SOL amount is too small"
    );
  }

  /*
  Fetch all required state.
  */

  const [
    global,
    feeConfig,
    state
  ] = await Promise.all([
    onlineSdk.fetchGlobal(),
    onlineSdk.fetchFeeConfig(),
    inspectToken(mint.toBase58())
  ]);

  /*
  Bonding curve token supply is used
  for fee calculation.
  */

  const mintSupply =
    state.bondingCurve.tokenTotalSupply;

  /*
  Calculate how many base tokens
  we should receive for the SOL input.
  */

  const tokenAmount =
    getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply,
      bondingCurve:
        state.bondingCurve,
      amount: new BN(lamports),
      quoteMint:
        state.quoteMint,
      quoteControl: null,
      creatorFeeBps:
        state.bondingCurve.creatorFeeBps
    });

  if (
    !tokenAmount ||
    tokenAmount.lte(new BN(0))
  ) {
    throw new Error(
      "Calculated token amount is zero"
    );
  }

  console.log(
    "Token amount:",
    tokenAmount.toString()
  );

  /*
  Build Pump.fun V2 instructions.
  */

  const instructions =
    await pumpSdk.buyV2Instructions({
      global,
      bondingCurveAccountInfo:
        state.bondingCurveAccountInfo,

      bondingCurve:
        state.bondingCurve,

      associatedUserAccountInfo:
        state.associatedUserAccountInfo,

      mint,

      user:
        wallet.publicKey,

      amount:
        tokenAmount,

      quoteAmount:
        new BN(lamports),

      slippage,

      tokenProgram:
        state.tokenProgram,

      quoteTokenProgram:
        state.quoteTokenProgram
    });

  /*
  Recent blockhash.
  */

  const latestBlockhash =
    await connection.getLatestBlockhash(
      "confirmed"
    );

  /*
  Build Versioned Transaction.
  */

  const message =
    new TransactionMessage({
      payerKey:
        wallet.publicKey,

      recentBlockhash:
        latestBlockhash.blockhash,

      instructions

    }).compileToV0Message();

  const transaction =
    new VersionedTransaction(
      message
    );

  /*
  Sign locally.
  This still does NOT send anything.
  */

  transaction.sign([
    wallet
  ]);

  console.log(
    "Instructions:",
    instructions.length
  );

  console.log(
    "Transaction:",
    "BUILT"
  );

  return {
    transaction,
    mint,
    tokenAmount,
    quoteAmount:
      new BN(lamports),
    blockhash:
      latestBlockhash.blockhash,
    lastValidBlockHeight:
      latestBlockhash.lastValidBlockHeight
  };
}


/*
==================================================
BUY SIMULATION
==================================================
No transaction is sent.
==================================================
*/

async function simulateBuy(
  mintAddress,
  solAmount = 0.01,
  slippage = 0.20
) {
  console.log("");
  console.log("================================");
  console.log("BUY SIMULATION");
  console.log("================================");

  const balance =
    await connection.getBalance(
      wallet.publicKey
    );

  console.log(
    "Wallet:",
    balance / 1e9,
    "SOL"
  );

  const requiredLamports =
    Math.floor(
      solAmount * 1_000_000_000
    );

  /*
  Simulation of a real transaction may
  still require payer funds because ATA
  creation / rent can be involved.
  */

  if (balance < requiredLamports) {
    console.log(
      "⚠️ Wallet does not have enough SOL for a realistic simulation."
    );
    console.log(
      "Transaction will be built, but simulation may fail due to balance."
    );
  }

  const result =
    await buildBuyTransaction(
      mintAddress,
      solAmount,
      slippage
    );

  console.log(
    "Simulating transaction..."
  );

  const simulation =
    await connection.simulateTransaction(
      result.transaction,
      {
        sigVerify: true,
        replaceRecentBlockhash: true
      }
    );

  if (simulation.value.err) {
    console.log("");
    console.log(
      "❌ BUY SIMULATION FAILED"
    );

    console.log(
      JSON.stringify(
        simulation.value.err,
        null,
        2
      )
    );

    if (simulation.value.logs) {
      console.log("");
      console.log(
        "Simulation logs:"
      );

      console.log(
        simulation.value.logs.join(
          "\n"
        )
      );
    }

    return {
      ok: false,
      simulated: true,
      error:
        simulation.value.err,
      logs:
        simulation.value.logs || []
    };
  }

  console.log("");
  console.log(
    "✅ BUY SIMULATION PASSED"
  );

  console.log(
    "Compute units:",
    simulation.value.unitsConsumed ||
      "N/A"
  );

  console.log(
    "REAL BUY:",
    "NOT SENT"
  );

  return {
    ok: true,
    simulated: true,
    tokenAmount:
      result.tokenAmount.toString(),
    quoteAmount:
      result.quoteAmount.toString(),
    logs:
      simulation.value.logs || []
  };
}


/*
==================================================
REAL BUY
==================================================
This is deliberately locked behind:
- realBuy === true
- ALLOW_REAL_TRADING=YES
==================================================
*/

async function buyToken({
  mintAddress,
  solAmount = 0.01,
  slippage = 0.20,
  realBuy = false
}) {
  console.log("");
  console.log("================================");
  console.log("BUY REQUEST");
  console.log("================================");
  console.log("Mint:", mintAddress);
  console.log(
    "Amount:",
    solAmount,
    "SOL"
  );

  /*
  Safety lock #1
  */

  if (!realBuy) {
    console.log(
      "REAL BUY: OFF"
    );

    return {
      ok: false,
      skipped: true,
      reason:
        "realBuy is false"
    };
  }

  /*
  Safety lock #2
  */

  if (!ALLOW_REAL_TRADING) {
    console.log(
      "REAL BUY BLOCKED"
    );

    console.log(
      "Set ALLOW_REAL_TRADING=YES only when intentionally enabling real trading."
    );

    return {
      ok: false,
      skipped: true,
      reason:
        "ALLOW_REAL_TRADING is not YES"
    };
  }

  /*
  Wallet balance check.
  */

  const balance =
    await connection.getBalance(
      wallet.publicKey
    );

  const lamports =
    Math.floor(
      solAmount * 1_000_000_000
    );

  if (
    balance <
    lamports
  ) {
    throw new Error(
      `Insufficient SOL. Balance=${balance / 1e9} SOL, requested=${solAmount} SOL`
    );
  }

  /*
  Build transaction.
  */

  const result =
    await buildBuyTransaction(
      mintAddress,
      solAmount,
      slippage
    );

  /*
  Final simulation before sending.
  */

  console.log(
    "Running final preflight simulation..."
  );

  const simulation =
    await connection.simulateTransaction(
      result.transaction,
      {
        sigVerify: true,
        replaceRecentBlockhash: true
      }
    );

  if (simulation.value.err) {
    console.log(
      "❌ FINAL BUY SIMULATION FAILED"
    );

    if (simulation.value.logs) {
      console.log(
        simulation.value.logs.join(
          "\n"
        )
      );
    }

    return {
      ok: false,
      sent: false,
      error:
        simulation.value.err
    };
  }

  console.log(
    "✅ FINAL SIMULATION PASSED"
  );

  /*
  ONLY HERE is the real transaction sent.
  */

  console.log(
    "🚨 SENDING REAL BUY..."
  );

  const signature =
    await connection.sendTransaction(
      result.transaction,
      {
        skipPreflight: false,
        maxRetries: 3
      }
    );

  console.log(
    "BUY TX:",
    signature
  );

  /*
  Wait for confirmation.
  */

  const confirmation =
    await connection.confirmTransaction(
      {
        signature,
        blockhash:
          result.blockhash,
        lastValidBlockHeight:
          result.lastValidBlockHeight
      },
      "confirmed"
    );

  if (confirmation.value.err) {
    console.log(
      "❌ BUY CONFIRMATION FAILED"
    );

    return {
      ok: false,
      sent: true,
      signature,
      error:
        confirmation.value.err
    };
  }

  console.log(
    "================================"
  );

  console.log(
    "✅ REAL BUY CONFIRMED"
  );

  console.log(
    "Signature:",
    signature
  );

  console.log(
    "================================"
  );

  return {
    ok: true,
    sent: true,
    confirmed: true,
    signature,
    tokenAmount:
      result.tokenAmount.toString(),
    quoteAmount:
      result.quoteAmount.toString()
  };
}


/*
==================================================
EXPORTS
==================================================
*/

module.exports = {
  wallet,
  connection,
  onlineSdk,
  pumpSdk,

  checkWallet,
  inspectToken,

  buildBuyTransaction,
  simulateBuy,
  buyToken
};


/*
==================================================
STARTUP CHECK
==================================================
*/

checkWallet().catch(error => {
  console.error(
    "Trader initialization error:",
    error.message
  );
});
