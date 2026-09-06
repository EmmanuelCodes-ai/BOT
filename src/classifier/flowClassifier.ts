// ============================================================
// Flow Classifier — Gatekeeper
//
// Responsibilities:
//   1. Derive macro bias from H1 and H4 candles (EMA + price structure)
//   2. Classify current M5 market state into a MarketFlow label
//   3. Evaluate all 5 strategies against that flow
//   4. Return the single highest-scoring, triggered strategy (or null)
//
// The classifier is the only path to execution — no strategy fires
// without passing through here first.
// ============================================================

import {
  Candle,
  MarketFlow,
  MacroBias,
  FlowClassification,
  StrategyResult,
  StrategyId,
  Signal,
  SignalDirection,
} from "../types";
import {
  calcEMA,
  calcEMASeries,
  calcATR,
  calcRSI,
  calcSwingLevels,
  calcLiquidityPools,
  buildIndicatorSnapshot,
} from "../indicators";
import { Strategy, StrategyContext } from "../strategies/base";
import { v4 as uuidv4 } from "uuid";

// ── Minimum score a strategy must reach to be considered ───
const MIN_SCORE_THRESHOLD = 65;

// ============================================================
// 1. Macro Bias — derived from H1/H4 EMA alignment
// ============================================================

/**
 * Determines directional bias from a higher-timeframe candle set.
 * Rules:
 *   - BULLISH : EMA9 > EMA21 > EMA50 AND price above EMA50
 *   - BEARISH : EMA9 < EMA21 < EMA50 AND price below EMA50
 *   - NEUTRAL : anything else (mixed / choppy structure)
 */
function deriveBias(candles: Candle[]): MacroBias {
  if (candles.length < 50) return MacroBias.NEUTRAL;

  const closes = candles.map((c) => c.close);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const price = closes[closes.length - 1];

  // Require meaningful separation (> 0.01% of price) to avoid flat markets
  const separation = price * 0.0001;

  const bullAligned =
    ema9 - ema21 > separation &&
    ema21 - ema50 > separation &&
    price > ema50;

  const bearAligned =
    ema21 - ema9 > separation &&
    ema50 - ema21 > separation &&
    price < ema50;

  if (bullAligned) return MacroBias.BULLISH;
  if (bearAligned) return MacroBias.BEARISH;
  return MacroBias.NEUTRAL;
}

// ============================================================
// 2. M5 Flow Classification
// ============================================================

/**
 * Classifies the current M5 market state using price action,
 * EMA dynamics, momentum, and structural context.
 *
 * Priority order (first match wins):
 *   1. Liquidity Sweep — wick beyond equal highs/lows + reversal close
 *   2. VWAP Extreme   — price stretched ≥0.3% from session VWAP
 *   3. Impulsive Trend — strong directional momentum, EMAs accelerating
 *   4. Pullback in trend — mild counter-move within aligned EMAs
 *   5. Key Level Test — price near a significant swing level
 *   6. Range Bound — low ATR/bandwidth, price oscillating around midpoint
 *   7. UNDEFINED
 */
function classifyM5Flow(
  m5Candles: Candle[],
  macroBias: MacroBias,
  vwapDeviation: number   // % distance from VWAP
): MarketFlow {
  if (m5Candles.length < 20) return MarketFlow.UNDEFINED;

  const closes = m5Candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const atr = calcATR(m5Candles, 14);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const rsi = calcRSI(closes, 14);

  const triggerCandle = m5Candles[m5Candles.length - 1];

  // ── 1. Liquidity Sweep ────────────────────────────────
  const pools = calcLiquidityPools(m5Candles, 0.05);
  for (const pool of pools) {
    if (pool.type === "EQH") {
      if (triggerCandle.high > pool.price && triggerCandle.close < pool.price) {
        return MarketFlow.LIQUIDITY_SWEEP;
      }
    } else {
      if (triggerCandle.low < pool.price && triggerCandle.close > pool.price) {
        return MarketFlow.LIQUIDITY_SWEEP;
      }
    }
  }

  // ── 2. VWAP Extreme ──────────────────────────────────
  if (Math.abs(vwapDeviation) >= 0.3) {
    return MarketFlow.VWAP_EXTREME;
  }

  // ── 3. Impulsive Trend ────────────────────────────────
  // Strong EMA separation + RSI momentum + price clearing all EMAs
  const ema9Series = calcEMASeries(closes, 9);
  const ema21Series = calcEMASeries(closes, 21);

  const ema9Slope =
    ema9Series.length >= 5
      ? ema9Series[ema9Series.length - 1] - ema9Series[ema9Series.length - 5]
      : 0;
  const ema21Slope =
    ema21Series.length >= 5
      ? ema21Series[ema21Series.length - 1] - ema21Series[ema21Series.length - 5]
      : 0;

  const emaAccelerating =
    Math.abs(ema9Slope) > atr * 0.3 && Math.sign(ema9Slope) === Math.sign(ema21Slope);

  if (emaAccelerating) {
    if (ema9Slope > 0 && price > ema9 && price > ema21 && rsi > 55) {
      return MarketFlow.IMPULSIVE_TREND_UP;
    }
    if (ema9Slope < 0 && price < ema9 && price < ema21 && rsi < 45) {
      return MarketFlow.IMPULSIVE_TREND_DOWN;
    }
  }

  // ── 4. Pullback in trend ──────────────────────────────
  const emaAlignedBull = ema9 > ema21 && ema21 > ema50;
  const emaAlignedBear = ema9 < ema21 && ema21 < ema50;

  if (emaAlignedBull && price <= ema9 * 1.002 && macroBias === MacroBias.BULLISH) {
    return MarketFlow.PULLBACK_IN_UPTREND;
  }
  if (emaAlignedBear && price >= ema9 * 0.998 && macroBias === MacroBias.BEARISH) {
    return MarketFlow.PULLBACK_IN_DOWNTREND;
  }

  // ── 5. Key Level Test ─────────────────────────────────
  const swingLevels = calcSwingLevels(m5Candles, 5, 15);
  const proximityThreshold = atr * 0.6;
  const nearLevel = swingLevels.some(
    (lvl) => Math.abs(lvl.price - price) <= proximityThreshold
  );
  if (nearLevel) return MarketFlow.KEY_LEVEL_TEST;

  // ── 6. Range Bound ────────────────────────────────────
  // Low ATR relative to recent average + compressed EMAs
  const recentATRs = m5Candles.slice(-20).map((_, i, arr) => {
    if (i === 0) return atr;
    return Math.abs(arr[i].close - arr[i - 1].close);
  });
  const avgRange =
    recentATRs.reduce((s, v) => s + v, 0) / recentATRs.length;
  const isCompressed = atr < avgRange * 1.1;

  const emaSpread =
    Math.abs(ema9 - ema21) + Math.abs(ema21 - ema50);
  const emasTight = emaSpread < atr * 0.5;

  if (isCompressed && emasTight) return MarketFlow.RANGE_BOUND;

  return MarketFlow.UNDEFINED;
}

// ============================================================
// 3. Flow Classifier — main class
// ============================================================

export class FlowClassifier {
  private strategies: Strategy[];

  constructor(strategies: Strategy[]) {
    this.strategies = strategies;
  }

  /**
   * Full classification + strategy selection pipeline.
   *
   * @param m5Candles   - Recent M5 closed candles (last candle = trigger)
   * @param h1Candles   - H1 candles for intermediate bias
   * @param h4Candles   - H4 candles for macro bias
   * @param sessionCandles - Current-session M5 candles for VWAP
   * @param atrMultiplierSL - From BotConfig
   * @param riskRewardRatio  - From BotConfig
   * @param symbol
   */
  classify(
    m5Candles: Candle[],
    h1Candles: Candle[],
    h4Candles: Candle[],
    sessionCandles: Candle[],
    atrMultiplierSL: number,
    riskRewardRatio: number,
    symbol: string
  ): ClassifierOutput {
    // ── Step 1: Macro bias ──────────────────────────────
    const h4Bias = deriveBias(h4Candles);
    const h1Bias = deriveBias(h1Candles);

    // Composite bias: H4 is primary, H1 can upgrade/downgrade
    let macroBias: MacroBias = h4Bias;
    if (h4Bias === MacroBias.NEUTRAL) {
      macroBias = h1Bias; // fall back to H1 when H4 is neutral
    } else if (h4Bias !== h1Bias && h1Bias !== MacroBias.NEUTRAL) {
      // Conflicting H4 vs H1 → treat as neutral
      macroBias = MacroBias.NEUTRAL;
    }

    // ── Step 2: Build indicator snapshot ───────────────
    const indicators = buildIndicatorSnapshot(m5Candles, sessionCandles);
    const vwapDeviation = indicators.vwap.deviationPct;

    // ── Step 3: Classify M5 flow ───────────────────────
    const flow: MarketFlow = classifyM5Flow(m5Candles, macroBias, vwapDeviation);

    // Confidence: higher when H1 and H4 agree
    const confidence =
      h4Bias === h1Bias && h4Bias !== MacroBias.NEUTRAL
        ? 0.85
        : h4Bias !== MacroBias.NEUTRAL || h1Bias !== MacroBias.NEUTRAL
        ? 0.60
        : 0.35;

    const flowClassification: FlowClassification = {
      flow,
      macroBias,
      h1Bias,
      h4Bias,
      confidence,
      timestamp: Date.now(),
    };

    // ── Step 4: Evaluate all strategies ────────────────
    const strategyCtx: StrategyContext = {
      candles: m5Candles,
      sessionCandles,
      indicators,
      flow: flowClassification,
      atrMultiplierSL,
      riskRewardRatio,
    };

    const results: StrategyResult[] = this.strategies.map((s) =>
      s.evaluate(strategyCtx)
    );

    // ── Step 5: Select best triggered strategy ─────────
    const candidates = results.filter(
      (r) => r.triggered && r.score >= MIN_SCORE_THRESHOLD
    );

    candidates.sort((a, b) => b.score - a.score);
    const winner = candidates[0] ?? null;

    // ── Step 6: Build Signal if winner exists ──────────
    let signal: Signal | null = null;
    if (winner && winner.entryPrice !== null) {
      const stopDistance = Math.abs(winner.entryPrice - winner.stopLoss!);
      const tpDistance = Math.abs(winner.takeProfit! - winner.entryPrice);
      const rrr = stopDistance > 0 ? tpDistance / stopDistance : 0;

      signal = {
        id: uuidv4(),
        timestamp: Date.now(),
        candleTimestamp: m5Candles[m5Candles.length - 1].timestamp,
        symbol,
        strategyId: winner.strategyId,
        flow: flowClassification,
        direction: winner.direction!,
        entryPrice: winner.entryPrice,
        stopLoss: winner.stopLoss!,
        takeProfit: winner.takeProfit!,
        riskRewardRatio: parseFloat(rrr.toFixed(2)),
        atr14: indicators.atr14,
        indicators,
        allScores: results.map((r) => ({
          strategyId: r.strategyId,
          score: r.score,
          triggered: r.triggered,
          reason: r.reason,
        })),
      };
    }

    return {
      flow: flowClassification,
      indicators,
      results,
      winner,
      signal,
    };
  }
}

// ============================================================
// Output shape
// ============================================================

export interface ClassifierOutput {
  flow: FlowClassification;
  indicators: ReturnType<typeof buildIndicatorSnapshot>;
  results: StrategyResult[];
  winner: StrategyResult | null;
  signal: Signal | null;
}
