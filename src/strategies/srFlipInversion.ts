// ============================================================
// Strategy 2: Support/Resistance Flip (Inversion)
// Logic:
//   - Identify recent swing high/low levels
//   - A level was broken (price traded through it)
//   - Price returns to retest the broken level from the other side
//   - Retest candle closes away from the level (rejection)
//   - Macro bias aligns with the trade direction
// ============================================================

import { StrategyResult, StrategyId, SignalDirection } from "../types";
import {
  calcSwingLevels,
  findNearestLevel,
} from "../indicators";
import { Strategy, StrategyContext } from "./base";

export class SRFlipInversionStrategy implements Strategy {
  id = StrategyId.SR_FLIP_INVERSION;

  evaluate(ctx: StrategyContext): StrategyResult {
    const { candles, indicators, flow, atrMultiplierSL, riskRewardRatio } = ctx;
    const { close, atr14 } = indicators;
    const { macroBias } = flow;

    const noSignal = (reason: string): StrategyResult => ({
      strategyId: StrategyId.SR_FLIP_INVERSION,
      triggered: false,
      direction: null,
      score: 0,
      entryPrice: null,
      stopLoss: null,
      takeProfit: null,
      reason,
      indicators,
    });

    if (candles.length < 30) return noSignal("Insufficient candle history");

    // ── 1. Detect swing levels ────────────────────────────
    const swingLevels = calcSwingLevels(candles, 5, 20);
    if (swingLevels.length === 0) return noSignal("No swing levels detected");

    // ── 2. Find a level that was recently broken ──────────
    // "Broken" = a candle closed beyond the level in the last 20 bars,
    // and now price has returned to it (within 0.5×ATR proximity).
    const recentCandles = candles.slice(-20);
    const proximityThreshold = atr14 * 0.5;

    let flipLevel: { price: number; direction: SignalDirection } | null = null;

    for (const lvl of swingLevels) {
      // Look for breaks of this level in recent candles
      if (lvl.type === "HIGH") {
        // Was there a bullish break? Any close > level price?
        const wasBroken = recentCandles.some((c) => c.close > lvl.price);
        // Are we now retesting it from above (potential S→R flip)?
        const retesting = Math.abs(close - lvl.price) <= proximityThreshold;
        if (wasBroken && retesting && close >= lvl.price) {
          // Level flipped to support — look for LONG
          if (macroBias !== "BEARISH") {
            flipLevel = { price: lvl.price, direction: SignalDirection.LONG };
            break;
          }
        }
      } else {
        // LOW level — potential R→S flip
        const wasBroken = recentCandles.some((c) => c.close < lvl.price);
        const retesting = Math.abs(close - lvl.price) <= proximityThreshold;
        if (wasBroken && retesting && close <= lvl.price) {
          if (macroBias !== "BULLISH") {
            flipLevel = { price: lvl.price, direction: SignalDirection.SHORT };
            break;
          }
        }
      }
    }

    if (!flipLevel) {
      return noSignal("No S/R flip retest detected near current price");
    }

    // ── 3. Rejection confirmation ─────────────────────────
    // Require the trigger candle to show rejection:
    // Bull: candle low tagged the level but closed well above it
    // Bear: candle high tagged the level but closed well below it
    const triggerCandle = candles[candles.length - 1];
    const bodySize = Math.abs(triggerCandle.close - triggerCandle.open);
    const candleRange = triggerCandle.high - triggerCandle.low;
    const wickRatio = candleRange > 0 ? bodySize / candleRange : 0;

    // We want a strong body (not a doji) closing away from level
    if (wickRatio < 0.4) {
      return noSignal("Trigger candle body too small — weak rejection");
    }

    // ── 4. Volume should confirm ───────────────────────────
    if (indicators.volumeMultiplier < 0.9) {
      return noSignal("Volume insufficient on retest candle");
    }

    // ── Score ──────────────────────────────────────────────
    let score = 72;
    if (indicators.volumeMultiplier >= 1.5) score += 8;
    if (macroBias !== "NEUTRAL") score += 10;
    if (wickRatio >= 0.6) score += 5;
    score = Math.min(score, 100);

    // ── Entry, SL, TP ─────────────────────────────────────
    const { direction } = flipLevel;
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
      strategyId: StrategyId.SR_FLIP_INVERSION,
      triggered: true,
      direction,
      score,
      entryPrice,
      stopLoss,
      takeProfit,
      reason: `S/R Flip at ${flipLevel.price.toFixed(4)} | ${direction} | VolMul=${indicators.volumeMultiplier.toFixed(2)} | WickRatio=${wickRatio.toFixed(2)}`,
      indicators,
    };
  }
}
