// ============================================================
// Strategy 5: Session VWAP Deviation Reversal
// Logic:
//   - Price has stretched significantly away from session VWAP
//     (default threshold: ≥0.3% deviation on liquid instruments)
//   - RSI confirms overextension (≥65 for short, ≤35 for long)
//   - A rejection candle forms (wick-heavy) in the extreme zone
//   - Entry targets reversion back toward VWAP (TP = midpoint)
//   - Best in range or mild-trend markets; avoided in impulsive flow
// ============================================================

import { StrategyResult, StrategyId, SignalDirection, MarketFlow } from "../types";
import { Strategy, StrategyContext } from "./base";

const EXCLUDED_FLOWS = new Set<MarketFlow>([
  MarketFlow.IMPULSIVE_TREND_UP,
  MarketFlow.IMPULSIVE_TREND_DOWN,
]);

const VWAP_DEVIATION_THRESHOLD_PCT = 0.3; // minimum % from VWAP to qualify

export class VWAPDeviationReversalStrategy implements Strategy {
  id = StrategyId.VWAP_DEVIATION_REVERSAL;

  evaluate(ctx: StrategyContext): StrategyResult {
    const { candles, indicators, flow, atrMultiplierSL, riskRewardRatio } = ctx;
    const { vwap, rsi14, atr14, close } = indicators;

    const noSignal = (reason: string): StrategyResult => ({
      strategyId: StrategyId.VWAP_DEVIATION_REVERSAL,
      triggered: false,
      direction: null,
      score: 0,
      entryPrice: null,
      stopLoss: null,
      takeProfit: null,
      reason,
      indicators,
    });

    // ── 1. Sanity checks ──────────────────────────────────
    if (vwap.vwap === 0) return noSignal("VWAP not available (no session data)");
    if (EXCLUDED_FLOWS.has(flow.flow)) {
      return noSignal(`Flow ${flow.flow} excludes mean-reversion strategies`);
    }
    if (candles.length < 5) return noSignal("Insufficient candle history");

    // ── 2. Deviation threshold ────────────────────────────
    const deviationAbs = Math.abs(vwap.deviationPct);
    if (deviationAbs < VWAP_DEVIATION_THRESHOLD_PCT) {
      return noSignal(
        `VWAP deviation ${deviationAbs.toFixed(3)}% below threshold (${VWAP_DEVIATION_THRESHOLD_PCT}%)`
      );
    }

    const isAboveVWAP = close > vwap.vwap;

    // ── 3. RSI confirmation ───────────────────────────────
    if (isAboveVWAP && rsi14 < 60) {
      return noSignal(`Above VWAP but RSI=${rsi14.toFixed(1)} not overextended (need ≥60)`);
    }
    if (!isAboveVWAP && rsi14 > 40) {
      return noSignal(`Below VWAP but RSI=${rsi14.toFixed(1)} not oversold (need ≤40)`);
    }

    // ── 4. Rejection candle check ─────────────────────────
    // Look for a wick-heavy candle at the extreme
    const triggerCandle = candles[candles.length - 1];
    const candleRange = triggerCandle.high - triggerCandle.low;
    const bodySize = Math.abs(triggerCandle.close - triggerCandle.open);
    const isRejection = candleRange > 0 && bodySize / candleRange < 0.6; // wick dominant

    if (!isRejection) {
      return noSignal("No clear rejection candle at VWAP deviation extreme");
    }

    // ── 5. Candle closed in the correct reversal direction ─
    const closedTowardVWAP =
      (isAboveVWAP && triggerCandle.close < triggerCandle.open) || // bear close
      (!isAboveVWAP && triggerCandle.close > triggerCandle.open);   // bull close

    if (!closedTowardVWAP) {
      return noSignal("Trigger candle did not close toward VWAP");
    }

    // ── Score ──────────────────────────────────────────────
    let score = 65;
    if (deviationAbs >= 0.5) score += 10;
    if (deviationAbs >= 0.8) score += 5;
    if (isAboveVWAP && rsi14 >= 70) score += 8;
    if (!isAboveVWAP && rsi14 <= 30) score += 8;
    if (flow.flow === MarketFlow.VWAP_EXTREME) score += 12;
    if (flow.flow === MarketFlow.RANGE_BOUND) score += 6;
    if (indicators.volumeMultiplier >= 1.2) score += 5;
    score = Math.min(score, 100);

    // ── Direction ─────────────────────────────────────────
    const direction = isAboveVWAP ? SignalDirection.SHORT : SignalDirection.LONG;

    // ── Entry, SL, TP ─────────────────────────────────────
    // TP targets halfway back to VWAP as a natural anchor,
    // but we still enforce 2R minimum via ATR
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
      strategyId: StrategyId.VWAP_DEVIATION_REVERSAL,
      triggered: true,
      direction,
      score,
      entryPrice,
      stopLoss,
      takeProfit,
      reason: `VWAP Deviation Reversal ${direction} | Dev=${vwap.deviationPct.toFixed(3)}% | RSI=${rsi14.toFixed(1)} | VWAP=${vwap.vwap.toFixed(4)}`,
      indicators,
    };
  }
}
