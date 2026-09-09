// ============================================================
// Mean-Reversion Trend Stack Guardrail Verification Test
// Covers: VWAPDeviationReversalStrategy and BBMeanReversionStrategy
// Run with: npx ts-node src/test/testMeanReversionGuardrails.ts
// ============================================================

import {
  Candle,
  IndicatorSnapshot,
  MarketFlow,
  MacroBias,
  SignalDirection,
  StrategyId,
} from "../types";
import { VWAPDeviationReversalStrategy } from "../strategies/vwapDeviationReversal";
import { BBMeanReversionStrategy } from "../strategies/bbMeanReversion";
import { StrategyContext } from "../strategies/base";

function makeCandles(closes: number[], lastWickRejection = true, bullReversal = false): Candle[] {
  const candles: Candle[] = [];
  const now = Date.now();
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i];
    const open = i > 0 ? closes[i - 1] : c;
    let high = Math.max(open, c) + 20;
    let low = Math.min(open, c) - 20;

    // For the last candle, format wick rejection if requested
    if (i === closes.length - 1 && lastWickRejection) {
      if (bullReversal) {
        // Bullish close with long lower wick
        const o = c - 10;
        high = c + 5;
        low = o - 60; // large lower wick
        candles.push({ timestamp: now + i * 300000, open: o, high, low, close: c, volume: 1500 });
        continue;
      } else {
        // Bearish close with long upper wick
        const o = c + 10;
        high = o + 60; // large upper wick
        low = c - 5;
        candles.push({ timestamp: now + i * 300000, open: o, high, low, close: c, volume: 1500 });
        continue;
      }
    }

    candles.push({ timestamp: now + i * 300000, open, high, low, close: c, volume: 1000 });
  }
  return candles;
}

function makeContext(opts: {
  candles: Candle[];
  close: number;
  rsi14: number;
  ema: { ema9: number; ema21: number; ema50: number; ema200: number };
  vwap?: { vwap: number; deviationPct: number };
  bollinger?: { upper: number; middle: number; lower: number; bandwidth: number; percentB: number };
  flow?: MarketFlow;
}): StrategyContext {
  const {
    candles,
    close,
    rsi14,
    ema,
    vwap = { vwap: 60000, deviationPct: 0.5 },
    bollinger = { upper: 60300, middle: 60000, lower: 59700, bandwidth: 0.01, percentB: 0.5 },
    flow = MarketFlow.RANGE_BOUND,
  } = opts;

  const indicators: IndicatorSnapshot = {
    timestamp: Date.now(),
    close,
    ema,
    rsi14,
    atr14: 150,
    avgATR50: 150,
    atrExpansionRatio: 1.0,
    bollinger,
    vwap,
    volume: 1200,
    avgVolume20: 1000,
    volumeMultiplier: 1.2,
  };

  return {
    candles,
    sessionCandles: candles,
    indicators,
    flow: {
      flow,
      macroBias: MacroBias.NEUTRAL,
      h1Bias: MacroBias.NEUTRAL,
      h4Bias: MacroBias.NEUTRAL,
      confidence: 0.8,
      timestamp: Date.now(),
    },
    atrMultiplierSL: 1.5,
    riskRewardRatio: 2.0,
  };
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${testName}`);
    if (detail) console.error(`     Detail: ${detail}`);
    failed++;
  }
}

console.log("\n🧪 Running Mean-Reversion Trend Stack Guardrail Tests...\n");

// ============================================================
// 1. VWAP DEVIATION REVERSAL TESTS
// ============================================================
console.log("── Testing VWAPDeviationReversalStrategy ──");
const vwapStrategy = new VWAPDeviationReversalStrategy();

// Case 1.1: Bullish EMA stack, above VWAP, moderate RSI (63) -> MUST BLOCK SHORT
{
  const candles = makeCandles([60000, 60100, 60200, 60350, 60300], true, false);
  const ctx = makeContext({
    candles,
    close: 60300,
    rsi14: 63,
    ema: { ema9: 60250, ema21: 60150, ema50: 60050, ema200: 59800 }, // 9 > 21 > 50 (Bullish)
    vwap: { vwap: 60000, deviationPct: 0.5 }, // +0.5% above VWAP
  });
  const res = vwapStrategy.evaluate(ctx);
  assert(!res.triggered, "VWAP: Bullish EMA stack blocks moderate RSI=63 SHORT");
  assert(res.reason.includes("Bullish EMA stack"), "VWAP: Reason cites Bullish EMA stack guardrail", res.reason);
}

// Case 1.2: Bullish EMA stack, above VWAP, RSI=75 (still < 80) -> MUST BLOCK SHORT
{
  const candles = makeCandles([60000, 60100, 60200, 60350, 60300], true, false);
  const ctx = makeContext({
    candles,
    close: 60300,
    rsi14: 75,
    ema: { ema9: 60250, ema21: 60150, ema50: 60050, ema200: 59800 }, // 9 > 21 > 50
    vwap: { vwap: 60000, deviationPct: 0.5 },
  });
  const res = vwapStrategy.evaluate(ctx);
  assert(!res.triggered, "VWAP: Bullish EMA stack blocks RSI=75 (< 80) SHORT");
}

// Case 1.3: Bullish EMA stack, above VWAP, extreme exhaustion RSI=82 (>= 80) -> ALLOWS SHORT
{
  const candles = makeCandles([60000, 60100, 60200, 60350, 60300], true, false);
  const ctx = makeContext({
    candles,
    close: 60300,
    rsi14: 82,
    ema: { ema9: 60250, ema21: 60150, ema50: 60050, ema200: 59800 }, // 9 > 21 > 50
    vwap: { vwap: 60000, deviationPct: 0.5 },
  });
  const res = vwapStrategy.evaluate(ctx);
  assert(res.triggered && res.direction === SignalDirection.SHORT, "VWAP: Bullish EMA stack permits true exhaustion RSI=82 SHORT");
}

// Case 1.4: Bearish EMA stack, below VWAP, moderate RSI (35) -> MUST BLOCK LONG
{
  const candles = makeCandles([60000, 59900, 59800, 59650, 59700], true, true);
  const ctx = makeContext({
    candles,
    close: 59700,
    rsi14: 35,
    ema: { ema9: 59750, ema21: 59850, ema50: 59950, ema200: 60200 }, // 9 < 21 < 50 (Bearish)
    vwap: { vwap: 60000, deviationPct: -0.5 }, // -0.5% below VWAP
  });
  const res = vwapStrategy.evaluate(ctx);
  assert(!res.triggered, "VWAP: Bearish EMA stack blocks moderate RSI=35 LONG");
  assert(res.reason.includes("Bearish EMA stack"), "VWAP: Reason cites Bearish EMA stack guardrail", res.reason);
}

// Case 1.5: Bearish EMA stack, below VWAP, true exhaustion RSI=18 (<= 20) -> ALLOWS LONG
{
  const candles = makeCandles([60000, 59900, 59800, 59650, 59700], true, true);
  const ctx = makeContext({
    candles,
    close: 59700,
    rsi14: 18,
    ema: { ema9: 59750, ema21: 59850, ema50: 59950, ema200: 60200 }, // 9 < 21 < 50
    vwap: { vwap: 60000, deviationPct: -0.5 },
  });
  const res = vwapStrategy.evaluate(ctx);
  assert(res.triggered && res.direction === SignalDirection.LONG, "VWAP: Bearish EMA stack permits true exhaustion RSI=18 LONG");
}

// Case 1.6: Neutral / tangled EMAs (no trend stack), RSI=65 -> ALLOWS SHORT
{
  const candles = makeCandles([60000, 60100, 60200, 60350, 60300], true, false);
  const ctx = makeContext({
    candles,
    close: 60300,
    rsi14: 65,
    ema: { ema9: 60150, ema21: 60200, ema50: 60100, ema200: 59800 }, // 9 < 21, but 21 > 50 (no trend stack)
    vwap: { vwap: 60000, deviationPct: 0.5 },
  });
  const res = vwapStrategy.evaluate(ctx);
  assert(res.triggered && res.direction === SignalDirection.SHORT, "VWAP: Neutral tangled EMAs allow standard RSI=65 SHORT");
}

// ============================================================
// 2. BOLLINGER BAND MEAN REVERSION TESTS
// ============================================================
console.log("\n── Testing BBMeanReversionStrategy ──");
const bbStrategy = new BBMeanReversionStrategy();

// Case 2.1: Bullish EMA stack, prev candle broke upper band (60350 > 60300), curr candle inside (60280), RSI=70 -> MUST BLOCK SHORT
{
  // prevCandle is candles[candles.length - 2]
  const candles = makeCandles([60000, 60100, 60350, 60280]);
  const ctx = makeContext({
    candles,
    close: 60280,
    rsi14: 70,
    ema: { ema9: 60250, ema21: 60150, ema50: 60050, ema200: 59800 }, // 9 > 21 > 50
    bollinger: { upper: 60300, middle: 60000, lower: 59700, bandwidth: 0.01, percentB: 0.96 },
  });
  const res = bbStrategy.evaluate(ctx);
  assert(!res.triggered, "BB: Bullish EMA stack blocks moderate RSI=70 SHORT");
  assert(res.reason.includes("Bullish EMA stack"), "BB: Reason cites Bullish EMA stack guardrail", res.reason);
}

// Case 2.2: Bullish EMA stack, prev candle broke upper band, curr candle inside, RSI=82 (>= 80) -> ALLOWS SHORT
{
  const candles = makeCandles([60000, 60100, 60350, 60280]);
  const ctx = makeContext({
    candles,
    close: 60280,
    rsi14: 82,
    ema: { ema9: 60250, ema21: 60150, ema50: 60050, ema200: 59800 }, // 9 > 21 > 50
    bollinger: { upper: 60300, middle: 60000, lower: 59700, bandwidth: 0.01, percentB: 0.96 },
  });
  const res = bbStrategy.evaluate(ctx);
  assert(res.triggered && res.direction === SignalDirection.SHORT, "BB: Bullish EMA stack permits true exhaustion RSI=82 SHORT");
}

// Case 2.3: Bearish EMA stack, prev candle broke lower band (59650 < 59700), curr candle inside (59720), RSI=30 -> MUST BLOCK LONG
{
  const candles = makeCandles([60000, 59900, 59650, 59720]);
  const ctx = makeContext({
    candles,
    close: 59720,
    rsi14: 30,
    ema: { ema9: 59750, ema21: 59850, ema50: 59950, ema200: 60200 }, // 9 < 21 < 50
    bollinger: { upper: 60300, middle: 60000, lower: 59700, bandwidth: 0.01, percentB: 0.04 },
  });
  const res = bbStrategy.evaluate(ctx);
  assert(!res.triggered, "BB: Bearish EMA stack blocks moderate RSI=30 LONG");
  assert(res.reason.includes("Bearish EMA stack"), "BB: Reason cites Bearish EMA stack guardrail", res.reason);
}

// Case 2.4: Bearish EMA stack, prev candle broke lower band, curr candle inside, RSI=17 (<= 20) -> ALLOWS LONG
{
  const candles = makeCandles([60000, 59900, 59650, 59720]);
  const ctx = makeContext({
    candles,
    close: 59720,
    rsi14: 17,
    ema: { ema9: 59750, ema21: 59850, ema50: 59950, ema200: 60200 }, // 9 < 21 < 50
    bollinger: { upper: 60300, middle: 60000, lower: 59700, bandwidth: 0.01, percentB: 0.04 },
  });
  const res = bbStrategy.evaluate(ctx);
  assert(res.triggered && res.direction === SignalDirection.LONG, "BB: Bearish EMA stack permits true exhaustion RSI=17 LONG");
}

// Case 2.5: Neutral / tangled EMAs (no trend stack), RSI=68 -> ALLOWS SHORT
{
  const candles = makeCandles([60000, 60100, 60350, 60280]);
  const ctx = makeContext({
    candles,
    close: 60280,
    rsi14: 68,
    ema: { ema9: 60150, ema21: 60200, ema50: 60100, ema200: 59800 }, // non-stacked
    bollinger: { upper: 60300, middle: 60000, lower: 59700, bandwidth: 0.01, percentB: 0.96 },
  });
  const res = bbStrategy.evaluate(ctx);
  assert(res.triggered && res.direction === SignalDirection.SHORT, "BB: Neutral tangled EMAs allow standard RSI=68 SHORT");
}

console.log(`\n============================================================`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`============================================================\n`);

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
