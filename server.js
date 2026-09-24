const express = require("express");
const path = require("path");

const app = express();
const PORT = 3000;

let latestToken = null;

app.use(express.json());
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

// Scanner -> Dashboard
app.get("/api/token", (req, res) => {
  res.json(latestToken || {});
});

// Test endpoint
app.post("/api/token", (req, res) => {
  latestToken = req.body;
  console.log("TOKEN RECEIVED:", latestToken);
  res.json({ ok: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("================================");
  console.log("PUMP.FUN PAPER TRADER");
  console.log("================================");
  console.log(`Dashboard running on port ${PORT}`);
});