// ============================================================
// Strategy 3: Bollinger Band Mean Reversion (RSI Filter)
// Logic:
//   - Price closes outside the outer Bollinger Band (overextension)
//   - RSI confirms the extreme (≥70 for short, ≤30 for long)
//   - Market flow should be RANGE_BOUND or mild trend
//   - Avoid during strong impulsive trends (momentum may continue)
//   - Trigger: next candle closes back inside the band
// ============================================================

import { StrategyResult, StrategyId, SignalDirection, MarketFlow } from "../types";
import { Strategy, StrategyContext } from "./base";

// Flows where mean-reversion is inappropriate
const EXCLUDED_FLOWS = new Set<MarketFlow>([
  MarketFlow.IMPULSIVE_TREND_UP,
  MarketFlow.IMPULSIVE_TREND_DOWN,
]);

const EXHAUSTION_RSI_SHORT = 80; // allow fading bullish EMA stack only if RSI >= 80
const EXHAUSTION_RSI_LONG = 20;  // allow fading bearish EMA stack only if RSI <= 20

export class BBMeanReversionStrategy implements Strategy {
  id = StrategyId.BB_MEAN_REVERSION;

  evaluate(ctx: StrategyContext): StrategyResult {
    const { candles, indicators, flow, atrMultiplierSL, riskRewardRatio } = ctx;
    const { bollinger, rsi14, atr14, close, ema } = indicators;
    const { upper, lower, middle } = bollinger;

    const noSignal = (reason: string): StrategyResult => ({
      strategyId: StrategyId.BB_MEAN_REVERSION,
      triggered: false,
      direction: null,
      score: 0,
      entryPrice: null,
      stopLoss: null,
      takeProfit: null,
      reason,
      indicators,
    });

    // ── 1. Avoid impulsive trending flows ─────────────────
    if (EXCLUDED_FLOWS.has(flow.flow)) {
      return noSignal(`Flow ${flow.flow} unsuitable for mean reversion`);
    }

    if (candles.length < 3) return noSignal("Insufficient candle history");

    // ── 2. Previous candle closed outside BB ──────────────
    // We check candles[length-2] (the one before current trigger)
    const prevCandle = candles[candles.length - 2];
    const prevClose = prevCandle.close;

    const prevWasAboveUpper = prevClose > upper;
    const prevWasBelowLower = prevClose < lower;

    if (!prevWasAboveUpper && !prevWasBelowLower) {
      return noSignal("Previous candle did not close outside Bollinger Band");
    }

    // ── 3. Trend Stack Guardrail ──────────────────────────
    // Block fading a strong EMA trend stack unless RSI is at true exhaustion
    const isBullishStack = ema.ema9 > ema.ema21 && ema.ema21 > ema.ema50;
    const isBearishStack = ema.ema9 < ema.ema21 && ema.ema21 < ema.ema50;

    if (prevWasAboveUpper && isBullishStack && rsi14 < EXHAUSTION_RSI_SHORT) {
      return noSignal(
        `Bullish EMA stack (9>21>50) active — blocking SHORT fade (RSI=${rsi14.toFixed(1)} < ${EXHAUSTION_RSI_SHORT} exhaustion)`
      );
    }
    if (prevWasBelowLower && isBearishStack && rsi14 > EXHAUSTION_RSI_LONG) {
      return noSignal(
        `Bearish EMA stack (9<21<50) active — blocking LONG fade (RSI=${rsi14.toFixed(1)} > ${EXHAUSTION_RSI_LONG} exhaustion)`
      );
    }

    // ── 4. RSI extreme confirmation ───────────────────────
    if (prevWasAboveUpper && rsi14 < 65) {
      return noSignal(`RSI=${rsi14.toFixed(1)} not extreme enough for short reversion (need ≥65)`);
    }
    if (prevWasBelowLower && rsi14 > 35) {
      return noSignal(`RSI=${rsi14.toFixed(1)} not extreme enough for long reversion (need ≤35)`);
    }

    // ── 5. Current candle closed back INSIDE the band ─────
    // This confirms the rejection and avoids chasing band-walking
    const closedInsideBand =
      (prevWasAboveUpper && close < upper) ||
      (prevWasBelowLower && close > lower);

    if (!closedInsideBand) {
      return noSignal("Price has not yet closed back inside Bollinger Band");
    }

    // ── 6. Bandwidth filter — avoid ultra-narrow bands (flat noise) ──
    if (bollinger.bandwidth < 0.002) {
      return noSignal(`Bollinger bandwidth too narrow (${bollinger.bandwidth.toFixed(4)}) — potential squeeze/noise`);
    }

    // ── Score ──────────────────────────────────────────────
    let score = 68;
    // Deeper RSI extreme = higher quality
    if (prevWasAboveUpper && rsi14 >= 75) score += 10;
    if (prevWasBelowLower && rsi14 <= 25) score += 10;
    // Range-bound market is ideal
    if (flow.flow === MarketFlow.RANGE_BOUND) score += 10;
    // Volume spike on the rejection bar adds conviction
    if (indicators.volumeMultiplier >= 1.3) score += 7;
    score = Math.min(score, 100);

    // ── Direction & levels ────────────────────────────────
    const direction = prevWasAboveUpper
      ? SignalDirection.SHORT
      : SignalDirection.LONG;

    const entryPrice = close;
    const stopDistance = atr14 * atrMultiplierSL;
    const stopLoss =
      direction === SignalDirection.LONG
        ? entryPrice - stopDistance
        : entryPrice + stopDistance;
    const tpDistance = stopDistance * riskRewardRatio;
    const takeProfit =
      direction === SignalDirection.LONG
        ? entryPrice + tpDistance
        : entryPrice - tpDistance;

    return {
      strategyId: StrategyId.BB_MEAN_REVERSION,
      triggered: true,
      direction,
      score,
      entryPrice,
      stopLoss,
      takeProfit,
      reason: `BB Mean Reversion ${direction} | RSI=${rsi14.toFixed(1)} | %B=${bollinger.percentB.toFixed(2)} | Flow=${flow.flow}`,
      indicators,
    };
  }
}
