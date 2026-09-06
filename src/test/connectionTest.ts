// ============================================================
// Connection & Pipeline Test
// Runs outside the bot loop — verifies:
//   1. Exchange connects and loads markets
//   2. M5 candles can be fetched
//   3. H1 / H4 candles can be fetched
//   4. Indicators compute without errors
//   5. Flow classifier runs and scores all 5 strategies
// ============================================================

import "dotenv/config";
import ccxt from "ccxt";
import { buildIndicatorSnapshot } from "../indicators";
import { FlowClassifier } from "../classifier";
import { buildStrategyRegistry } from "../strategies";

const SYMBOL = process.env.SYMBOL ?? "BTC/USDT:USDT";
const MARKET_TYPE = process.env.MARKET_TYPE ?? "future";

async function run(): Promise<void> {
  console.log("\n══════════════════════════════════════════");
  console.log("   Multi-Strategy Bot — Connection Test   ");
  console.log("══════════════════════════════════════════\n");

  // ── Step 1: Build exchange ────────────────────────────────
  console.log("[ 1 ] Building exchange connection...");

  const isDemoMode =
    process.env.BYBIT_DEMO_MODE === "true" &&
    process.env.EXCHANGE_ID === "bybit";

  const exchangeId = process.env.EXCHANGE_ID ?? "bybit";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ExchangeClass = (ccxt as any)[exchangeId];
  if (!ExchangeClass) throw new Error(`Unknown exchange: ${exchangeId}`);

  const exchange = new ExchangeClass({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    ...(isDemoMode && {
      urls: {
        api: {
          public: "https://api-demo.bybit.com",
          private: "https://api-demo.bybit.com",
        },
      },
    }),
    options: {
      defaultType: MARKET_TYPE,
      fetchCurrencies: false,
      ...(isDemoMode && { demo: true }),
    },
  });

  // Force-disable fetchCurrencies at the instance level.
  (exchange as any).fetchCurrencies = async () => ({});

  console.log(`     Exchange : ${exchangeId}`);
  console.log(`     Demo mode: ${isDemoMode}`);
  console.log(`     Symbol   : ${SYMBOL}`);

  // ── Step 2: Load markets ──────────────────────────────────
  console.log("\n[ 2 ] Loading markets...");
  const t0 = Date.now();
  await exchange.loadMarkets();
  console.log(`     ✓ Markets loaded in ${Date.now() - t0}ms`);

  const marketExists = exchange.markets[SYMBOL] !== undefined;
  if (!marketExists) {
    throw new Error(`Symbol ${SYMBOL} not found on ${exchangeId}`);
  }
  console.log(`     ✓ Symbol ${SYMBOL} confirmed`);

  // ── Step 3: Fetch M5 candles ──────────────────────────────
  console.log("\n[ 3 ] Fetching M5 candles (300)...");
  const t1 = Date.now();
  const raw5m = await exchange.fetchOHLCV(SYMBOL, "5m", undefined, 301);
  const m5Candles = raw5m.slice(0, -1).map((c: any) => ({
    timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
  }));
  console.log(`     ✓ ${m5Candles.length} M5 candles fetched in ${Date.now() - t1}ms`);
  const last5m = m5Candles[m5Candles.length - 1];
  console.log(`     Latest close : ${last5m.close} @ ${new Date(last5m.timestamp).toISOString()}`);

  // ── Step 4: Fetch H1 / H4 candles ────────────────────────
  console.log("\n[ 4 ] Fetching H1 and H4 candles (100 each)...");
  const t2 = Date.now();
  const [rawH1, rawH4] = await Promise.all([
    exchange.fetchOHLCV(SYMBOL, "1h", undefined, 101),
    exchange.fetchOHLCV(SYMBOL, "4h", undefined, 101),
  ]);
  const h1Candles = rawH1.slice(0, -1).map((c: any) => ({
    timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
  }));
  const h4Candles = rawH4.slice(0, -1).map((c: any) => ({
    timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
  }));
  console.log(`     ✓ H1: ${h1Candles.length} candles | H4: ${h4Candles.length} candles (${Date.now() - t2}ms)`);

  // ── Step 5: Build indicator snapshot ─────────────────────
  console.log("\n[ 5 ] Computing indicators...");
  const snap = buildIndicatorSnapshot(m5Candles, m5Candles.slice(-96)); // ~8h session window
  console.log(`     EMA9  : ${snap.ema.ema9.toFixed(2)}`);
  console.log(`     EMA21 : ${snap.ema.ema21.toFixed(2)}`);
  console.log(`     EMA50 : ${snap.ema.ema50.toFixed(2)}`);
  console.log(`     RSI14 : ${snap.rsi14.toFixed(1)}`);
  console.log(`     ATR14 : ${snap.atr14.toFixed(4)}`);
  console.log(`     BB    : ${snap.bollinger.lower.toFixed(2)} / ${snap.bollinger.middle.toFixed(2)} / ${snap.bollinger.upper.toFixed(2)}`);
  console.log(`     VWAP  : ${snap.vwap.vwap.toFixed(2)} (dev ${snap.vwap.deviationPct.toFixed(3)}%)`);
  console.log(`     VolMul: ${snap.volumeMultiplier.toFixed(2)}x`);
  console.log("     ✓ Indicators OK");

  // ── Step 6: Run Flow Classifier ───────────────────────────
  console.log("\n[ 6 ] Running Flow Classifier...");
  const strategies = buildStrategyRegistry();
  const classifier = new FlowClassifier(strategies);

  const output = classifier.classify(
    m5Candles,
    h1Candles,
    h4Candles,
    m5Candles.slice(-96),
    1.5,  // atrMultiplierSL
    2,    // riskRewardRatio
    SYMBOL
  );

  console.log(`     H4 Bias    : ${output.flow.h4Bias}`);
  console.log(`     H1 Bias    : ${output.flow.h1Bias}`);
  console.log(`     Macro Bias : ${output.flow.macroBias}`);
  console.log(`     M5 Flow    : ${output.flow.flow}`);
  console.log(`     Confidence : ${(output.flow.confidence * 100).toFixed(0)}%`);

  console.log("\n     Strategy scores:");
  for (const r of output.results) {
    const status = r.triggered ? "✓ TRIGGERED" : "  no signal";
    console.log(`       ${r.strategyId.padEnd(30)} score=${r.score.toString().padStart(3)}  ${status}`);
    if (!r.triggered) {
      console.log(`         → ${r.reason}`);
    }
  }

  if (output.signal) {
    console.log(`\n     ★ SIGNAL SELECTED: ${output.signal.strategyId}`);
    console.log(`       Direction : ${output.signal.direction}`);
    console.log(`       Entry     : ${output.signal.entryPrice}`);
    console.log(`       Stop Loss : ${output.signal.stopLoss}`);
    console.log(`       Take Profit: ${output.signal.takeProfit}`);
    console.log(`       R:R       : ${output.signal.riskRewardRatio}`);
  } else {
    console.log("\n     No signal this bar (normal — not every candle fires)");
  }

  console.log("\n══════════════════════════════════════════");
  console.log("   All tests passed ✓                     ");
  console.log("══════════════════════════════════════════\n");
}

run().catch((err) => {
  console.error("\n✗ Test failed:", err.message ?? err);
  process.exit(1);
});
