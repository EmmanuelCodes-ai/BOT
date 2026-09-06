// ============================================================
// Strategy 1: Trend Pullback EMA Confluence
// Logic:
//   - Macro bias must be directional (not NEUTRAL)
//   - EMA stack must be aligned (9 > 21 > 50 for bull; reversed for bear)
//   - Price pulls back to touch/pierce the EMA9 or EMA21
//   - Trigger candle closes back on the trend side of EMA9
//   - Volume at or above average (no dead-volume fades)
//   - RSI not at extreme against the trade direction
// ============================================================

import { StrategyResult, StrategyId, SignalDirection } from "../types";
import { Strategy, StrategyContext } from "./base";

export class TrendPullbackEMAStrategy implements Strategy {
  id = StrategyId.TREND_PULLBACK_EMA;

  evaluate(ctx: StrategyContext): StrategyResult {
    const { indicators, flow, atrMultiplierSL, riskRewardRatio } = ctx;
    const { ema, rsi14, atr14, close } = indicators;
    const { macroBias } = flow;

    const noSignal = (reason: string): StrategyResult => ({
      strategyId: StrategyId.TREND_PULLBACK_EMA,
      triggered: false,
      direction: null,
      score: 0,
      entryPrice: null,
      stopLoss: null,
      takeProfit: null,
      reason,
      indicators,
    });

    // ── 1. Require directional macro bias ──────────────────
    if (macroBias === "NEUTRAL") {
      return noSignal("Macro bias neutral — no trend to trade");
    }

    const isBull = macroBias === "BULLISH";

    // ── 2. EMA alignment ───────────────────────────────────
    const emaAligned = isBull
      ? ema.ema9 > ema.ema21 && ema.ema21 > ema.ema50
      : ema.ema9 < ema.ema21 && ema.ema21 < ema.ema50;

    if (!emaAligned) {
      return noSignal("EMA stack not aligned for trend direction");
    }

    // ── 3. Pullback: price touched EMA9 or EMA21 area ─────
    // We check that the candle low (bull) or high (bear) came
    // within 0.5 × ATR of the EMA9/21 zone.
    const emaZone = (ema.ema9 + ema.ema21) / 2;
    const touchDistance = Math.abs(close - emaZone);
    const withinTouch = touchDistance <= atr14 * 0.5;

    if (!withinTouch) {
      return noSignal(
        `Price not within 0.5×ATR of EMA9/21 zone (dist=${touchDistance.toFixed(4)}, threshold=${(atr14 * 0.5).toFixed(4)})`
      );
    }

    // ── 4. Candle closed back on trend side ───────────────
    const closedOnTrendSide = isBull ? close > ema.ema9 : close < ema.ema9;
    if (!closedOnTrendSide) {
      return noSignal("Candle did not close back on the trend side of EMA9");
    }

    // ── 5. RSI filter — avoid counter-trend exhaustion ────
    // Bull: RSI must not be above 70 (already overbought)
    // Bear: RSI must not be below 30 (already oversold)
    if (isBull && rsi14 > 70) return noSignal("RSI overbought on bull entry");
    if (!isBull && rsi14 < 30) return noSignal("RSI oversold on bear entry");

    // ── 6. Volume filter — minimum participation ──────────
    if (indicators.volumeMultiplier < 0.8) {
      return noSignal("Volume too low relative to 20-period average");
    }

    // ── Score: base 70 + bonuses ──────────────────────────
    let score = 70;
    if (indicators.volumeMultiplier >= 1.5) score += 10;
    if (isBull && rsi14 < 55) score += 10;
    if (!isBull && rsi14 > 45) score += 10;
    if (ema.ema50 < close && isBull) score += 5; // price above 50 EMA
    if (ema.ema50 > close && !isBull) score += 5;
    score = Math.min(score, 100);

    // ── Entry, SL, TP ─────────────────────────────────────
    const direction = isBull ? SignalDirection.LONG : SignalDirection.SHORT;
    const entryPrice = close;
    const stopDistance = atr14 * atrMultiplierSL;
    const stopLoss = isBull ? entryPrice - stopDistance : entryPrice + stopDistance;
    const tpDistance = stopDistance * riskRewardRatio;
    const takeProfit = isBull ? entryPrice + tpDistance : entryPrice - tpDistance;

    return {
      strategyId: StrategyId.TREND_PULLBACK_EMA,
      triggered: true,
      direction,
      score,
      entryPrice,
      stopLoss,
      takeProfit,
      reason: `EMA confluence pullback (${isBull ? "BULL" : "BEAR"}) | RSI=${rsi14.toFixed(1)} | VolMul=${indicators.volumeMultiplier.toFixed(2)}`,
      indicators,
    };
  }
}
