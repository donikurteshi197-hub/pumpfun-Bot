const { spawn } = require("child_process");
const http = require("http");

const SERVER_PORT = 3000;

let serverProcess = null;
let botProcess = null;
let shuttingDown = false;
let botStarted = false;

console.log("================================");
console.log("PUMP.FUN BOT STARTER");
console.log("================================");
console.log("AUTO SERVER: ON");
console.log("AUTO BOT: ON");
console.log("WAIT FOR SERVER: ON");
console.log("AUTO RESTART: ON");
console.log("================================");

function startProcess(name, file) {
  console.log(`[START] ${name}: ${file}`);

  const child = spawn(process.execPath, [file], {
    stdio: "inherit",
    cwd: __dirname
  });

  child.on("error", (error) => {
    console.log(`[${name}] ERROR: ${error.message}`);
  });

  child.on("exit", (code, signal) => {
    console.log(
      `[${name}] stopped. code=${code} signal=${signal || "none"}`
    );

    if (shuttingDown) return;

    if (name === "SERVER") {
      serverProcess = null;
      botStarted = false;

      if (botProcess) {
        botProcess.kill("SIGTERM");
        botProcess = null;
      }

      console.log("[SERVER] Restarting in 2 seconds...");

      setTimeout(() => {
        if (!shuttingDown) {
          startServer();
        }
      }, 2000);
    }

    if (name === "BOT") {
      botProcess = null;

      console.log("[BOT] Restarting in 2 seconds...");

      setTimeout(() => {
        if (!shuttingDown && serverProcess) {
          startBot();
        }
      }, 2000);
    }
  });

  return child;
}

function checkServer() {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port: SERVER_PORT,
        path: "/"
      },
      (res) => {
        res.resume();
        resolve(true);
      }
    );

    req.on("error", () => resolve(false));

    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer() {
  console.log("[SERVER] Waiting for port 3000...");

  while (!shuttingDown) {
    const ready = await checkServer();

    if (ready) {
      console.log("[SERVER] READY: http://127.0.0.1:3000");
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

async function startBot() {
  if (shuttingDown || botStarted || botProcess) return;

  const ready = await waitForServer();

  if (!ready || shuttingDown) return;

  botStarted = true;
  botProcess = startProcess("BOT", "bot.js");
}

function startServer() {
  if (shuttingDown || serverProcess) return;

  serverProcess = startProcess("SERVER", "server.js");

  startBot();
}

function shutdown() {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log("");
  console.log("================================");
  console.log("STOPPING PUMP.FUN BOT");
  console.log("================================");

  if (botProcess) {
    console.log("Stopping BOT...");
    botProcess.kill("SIGTERM");
  }

  if (serverProcess) {
    console.log("Stopping SERVER...");
    serverProcess.kill("SIGTERM");
  }

  setTimeout(() => {
    process.exit(0);
  }, 1000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startServer();
