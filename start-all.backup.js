const { spawn } = require("child_process");

function start(name, file) {
  const p = spawn(process.execPath, [file], {
    stdio: "inherit",
    cwd: __dirname
  });

  p.on("exit", (code) => {
    console.log(`${name} stopped with code ${code}`);
  });

  return p;
}

console.log("================================");
console.log("PUMP.FUN BOT STARTER");
console.log("================================");

const server = start("SERVER", "server.js");

setTimeout(() => {
  start("BOT", "bot.js");
}, 2000);

process.on("SIGINT", () => {
  console.log("\nStopping server and bot...");
  server.kill("SIGINT");
  process.exit(0);
});
