// ============================================================
// Strategy Registry — barrel export + factory
// ============================================================

export { TrendPullbackEMAStrategy } from "./trendPullbackEMA";
export { SRFlipInversionStrategy } from "./srFlipInversion";
export { BBMeanReversionStrategy } from "./bbMeanReversion";
export { LiquiditySweepReversalStrategy } from "./liquiditySweepReversal";
export { VWAPDeviationReversalStrategy } from "./vwapDeviationReversal";
export type { Strategy, StrategyContext } from "./base";

import { TrendPullbackEMAStrategy } from "./trendPullbackEMA";
import { SRFlipInversionStrategy } from "./srFlipInversion";
import { BBMeanReversionStrategy } from "./bbMeanReversion";
import { LiquiditySweepReversalStrategy } from "./liquiditySweepReversal";
import { VWAPDeviationReversalStrategy } from "./vwapDeviationReversal";
import { Strategy } from "./base";

/**
 * Returns one instance of every strategy.
 * The flow classifier will evaluate all of them and select the best.
 */
export function buildStrategyRegistry(): Strategy[] {
  return [
    new TrendPullbackEMAStrategy(),
    new SRFlipInversionStrategy(),
    new BBMeanReversionStrategy(),
    new LiquiditySweepReversalStrategy(),
    new VWAPDeviationReversalStrategy(),
  ];
}
