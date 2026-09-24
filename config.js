module.exports = {
  // PAPER = testim pa para
  // LIVE = tregtim real
  MODE: "PAPER",

  // Shuma për çdo trade
  TRADE_AMOUNT_SOL: 0.05,

  // Shitje kur arrin fitimin
  TAKE_PROFIT_PERCENT: 50,

  // Shitje kur arrin humbjen
  STOP_LOSS_PERCENT: 10,

  // Mbyllje automatike pas 50 sekondash
  MAX_HOLD_SECONDS: 50,

  // Mund të mbajë disa tokenë njëkohësisht
  MAX_OPEN_POSITIONS: 5,

  // Maksimumi i paper-trade-ve në ditë
  MAX_DAILY_TRADES: 100,

  // Nuk bëjmë verifikime të komplikuara
  ALLOW_VERIFIED: true,
  ALLOW_UNVERIFIED: true
};
