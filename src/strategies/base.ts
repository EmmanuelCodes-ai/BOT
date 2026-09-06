// ============================================================
// Strategy Base Interface
// Every strategy implements this contract.
// ============================================================

import { Candle, StrategyResult, IndicatorSnapshot, FlowClassification } from "../types";

export interface StrategyContext {
  /** Closed M5 candles — evaluate against candles[length-1] (the last closed candle) */
  candles: Candle[];
  /** Session candles only (for VWAP-aware strategies) */
  sessionCandles: Candle[];
  /** Pre-built indicator snapshot for the current bar */
  indicators: IndicatorSnapshot;
  /** Flow classification from the gatekeeper */
  flow: FlowClassification;
  /** ATR multiplier for stop placement (from config) */
  atrMultiplierSL: number;
  /** Risk:reward ratio (from config, typically 2) */
  riskRewardRatio: number;
}

export interface Strategy {
  id: string;
  evaluate(ctx: StrategyContext): StrategyResult;
}
