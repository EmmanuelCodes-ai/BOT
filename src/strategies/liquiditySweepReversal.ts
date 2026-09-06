// ============================================================
// Strategy 4: Liquidity Sweep & Displacement Reversal
// Logic:
//   - Detects equal highs (EQH) or equal lows (EQL) — liquidity pools
//   - Price sweeps above EQH or below EQL (stop-hunt)
//   - A large displacement candle (≥1.5×ATR body) aggressively
//     closes back on the other side — institutional reversal signal
//   - Entry is taken on the close of the displacement candle
//   - Works in any market flow; scored higher in range/key-level context
// ============================================================

import { StrategyResult, StrategyId, SignalDirection, MarketFlow } from "../types";
import { calcLiquidityPools, isDisplacementCandle, LiquidityPool } from "../indicators";
import { Strategy, StrategyContext } from "./base";

export class LiquiditySweepReversalStrategy implements Strategy {
  id = StrategyId.LIQUIDITY_SWEEP_REVERSAL;

  evaluate(ctx: StrategyContext): StrategyResult {
    const { candles, indicators, flow, atrMultiplierSL, riskRewardRatio } = ctx;
    const { atr14, close } = indicators;

    const noSignal = (reason: string): StrategyResult => ({
      strategyId: StrategyId.LIQUIDITY_SWEEP_REVERSAL,
      triggered: false,
      direction: null,
      score: 0,
      entryPrice: null,
      stopLoss: null,
      takeProfit: null,
      reason,
      indicators,
    });

    if (candles.length < 20) return noSignal("Insufficient candle history");

    // ── 1. Identify liquidity pools ───────────────────────
    const pools = calcLiquidityPools(candles, 0.05);
    if (pools.length === 0) return noSignal("No liquidity pools detected");

    // ── 2. Detect a sweep ─────────────────────────────────
    // Check if the trigger candle's wick swept a pool level
    // then closed on the opposite side — the reversal setup.
    const triggerCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2];

    let sweptPool: LiquidityPool | null = null;
    let sweepDirection: SignalDirection | null = null;

    for (const pool of pools) {
      if (pool.type === "EQH") {
        // Sweep above equal highs: wick went above pool, close came back below
        const wickAbove = triggerCandle.high > pool.price;
        const closedBelow = triggerCandle.close < pool.price;
        if (wickAbove && closedBelow) {
          sweptPool = pool;
          sweepDirection = SignalDirection.SHORT;
          break;
        }
      } else {
        // Sweep below equal lows: wick went below pool, close came back above
        const wickBelow = triggerCandle.low < pool.price;
        const closedAbove = triggerCandle.close > pool.price;
        if (wickBelow && closedAbove) {
          sweptPool = pool;
          sweepDirection = SignalDirection.LONG;
          break;
        }
      }
    }

    if (!sweptPool || !sweepDirection) {
      return noSignal("No liquidity sweep detected on trigger candle");
    }

    // ── 3. Displacement confirmation ──────────────────────
    // The trigger candle must have a large body relative to ATR
    if (!isDisplacementCandle(triggerCandle, atr14, 1.5)) {
      return noSignal(
        `Trigger candle body not large enough (body=${Math.abs(triggerCandle.close - triggerCandle.open).toFixed(4)}, need ≥ ${(atr14 * 1.5).toFixed(4)})`
      );
    }

    // ── 4. Macro bias alignment check (loose) ─────────────
    // We allow sweeps against macro bias but penalize the score
    const biasAligned =
      (sweepDirection === SignalDirection.LONG &&
        flow.macroBias !== "BEARISH") ||
      (sweepDirection === SignalDirection.SHORT &&
        flow.macroBias !== "BULLISH");

    // ── Score ──────────────────────────────────────────────
    let score = 75;
    if (sweptPool.touches >= 3) score += 8;  // stronger pool = more stops resting
    if (biasAligned) score += 8;
    if (flow.flow === MarketFlow.LIQUIDITY_SWEEP) score += 10;
    if (flow.flow === MarketFlow.RANGE_BOUND || flow.flow === MarketFlow.KEY_LEVEL_TEST) score += 5;
    if (indicators.volumeMultiplier >= 1.5) score += 5;
    score = Math.min(score, 100);

    // ── Entry, SL, TP ─────────────────────────────────────
    const entryPrice = close;
    const stopDistance = atr14 * atrMultiplierSL;
    const stopLoss =
      sweepDirection === SignalDirection.LONG
        ? entryPrice - stopDistance
        : entryPrice + stopDistance;
    const tpDistance = stopDistance * riskRewardRatio;
    const takeProfit =
      sweepDirection === SignalDirection.LONG
        ? entryPrice + tpDistance
        : entryPrice - tpDistance;

    return {
      strategyId: StrategyId.LIQUIDITY_SWEEP_REVERSAL,
      triggered: true,
      direction: sweepDirection,
      score,
      entryPrice,
      stopLoss,
      takeProfit,
      reason: `Liquidity Sweep ${sweepDirection} at pool=${sweptPool.price.toFixed(4)} (touches=${sweptPool.touches}) | DispCandle | VolMul=${indicators.volumeMultiplier.toFixed(2)}`,
      indicators,
    };
  }
}
