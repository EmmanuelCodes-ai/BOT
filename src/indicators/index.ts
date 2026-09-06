// ============================================================
// Indicator Utilities — pure, stateless calculation functions
// All functions operate on arrays of Candle data and return
// the most recent value unless otherwise noted.
// ============================================================

import {
  Candle,
  EMASnapshot,
  BollingerSnapshot,
  VWAPSnapshot,
  IndicatorSnapshot,
} from "../types";

// ------------------------------------------------------------
// EMA — Exponential Moving Average
// ------------------------------------------------------------

/**
 * Calculates a full EMA series for a given period.
 * Returns an array of the same length as `closes`; early values
 * that cannot yet be computed are seeded from a simple mean.
 */
export function calcEMASeries(closes: number[], period: number): number[] {
  if (closes.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];

  // Seed with SMA of the first `period` values
  let seed = 0;
  const seedLen = Math.min(period, closes.length);
  for (let i = 0; i < seedLen; i++) seed += closes[i];
  result[0] = seed / seedLen;

  for (let i = 1; i < closes.length; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

/** Latest EMA value for a given period */
export function calcEMA(closes: number[], period: number): number {
  const series = calcEMASeries(closes, period);
  return series[series.length - 1];
}

/** Snapshot of the four EMAs used across strategies */
export function calcEMASnapshot(closes: number[]): EMASnapshot {
  return {
    ema9: calcEMA(closes, 9),
    ema21: calcEMA(closes, 21),
    ema50: calcEMA(closes, 50),
    ema200: calcEMA(closes, 200),
  };
}

// ------------------------------------------------------------
// SMA — Simple Moving Average
// ------------------------------------------------------------

export function calcSMA(values: number[], period: number): number {
  if (values.length < period) {
    // Partial SMA on whatever data we have
    return values.reduce((s, v) => s + v, 0) / values.length;
  }
  const slice = values.slice(values.length - period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

// ------------------------------------------------------------
// ATR — Average True Range (14-period default)
// ------------------------------------------------------------

function trueRange(candle: Candle, prevClose: number): number {
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - prevClose),
    Math.abs(candle.low - prevClose)
  );
}

/**
 * Wilder's smoothed ATR.
 * Requires at least 2 candles; returns 0 for a single-candle set.
 */
export function calcATR(candles: Candle[], period: number = 14): number {
  if (candles.length < 2) return 0;

  // Build TR series
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(trueRange(candles[i], candles[i - 1].close));
  }

  if (trs.length === 0) return 0;

  // Seed with simple average of first `period` TRs
  const seedLen = Math.min(period, trs.length);
  let atr = trs.slice(0, seedLen).reduce((s, v) => s + v, 0) / seedLen;

  // Wilder smooth over the rest
  for (let i = seedLen; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// ------------------------------------------------------------
// RSI — Relative Strength Index (14-period default)
// ------------------------------------------------------------

export function calcRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50; // neutral fallback

  let gains = 0;
  let losses = 0;

  // Initial average gain/loss over first `period` changes
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Wilder smooth over remaining closes
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ------------------------------------------------------------
// Bollinger Bands (20-period SMA, 2 std deviations)
// ------------------------------------------------------------

export function calcBollinger(
  closes: number[],
  period: number = 20,
  stdDev: number = 2
): BollingerSnapshot {
  const price = closes[closes.length - 1];
  const slice = closes.slice(Math.max(0, closes.length - period));
  const mean = slice.reduce((s, v) => s + v, 0) / slice.length;

  const variance =
    slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / slice.length;
  const sd = Math.sqrt(variance);

  const upper = mean + stdDev * sd;
  const lower = mean - stdDev * sd;
  const bandwidth = upper - lower > 0 ? (upper - lower) / mean : 0;
  const percentB =
    upper - lower > 0 ? (price - lower) / (upper - lower) : 0.5;

  return { upper, middle: mean, lower, bandwidth, percentB };
}

// ------------------------------------------------------------
// VWAP — Session Volume-Weighted Average Price
// Rolling calculation from the start of the current session.
// ------------------------------------------------------------

/**
 * Calculates VWAP over the provided candles (assumed to be
 * only current-session candles, already filtered by the caller).
 */
export function calcVWAP(candles: Candle[]): VWAPSnapshot {
  if (candles.length === 0) {
    return { vwap: 0, deviationPct: 0 };
  }

  let cumulativeTPV = 0; // sum of (typicalPrice * volume)
  let cumulativeVol = 0;

  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumulativeTPV += tp * c.volume;
    cumulativeVol += c.volume;
  }

  const vwap = cumulativeVol > 0 ? cumulativeTPV / cumulativeVol : 0;
  const lastClose = candles[candles.length - 1].close;
  const deviationPct = vwap > 0 ? ((lastClose - vwap) / vwap) * 100 : 0;

  return { vwap, deviationPct };
}

// ------------------------------------------------------------
// Average Volume
// ------------------------------------------------------------

export function calcAvgVolume(candles: Candle[], period: number = 20): number {
  const slice = candles.slice(Math.max(0, candles.length - period));
  if (slice.length === 0) return 1;
  return slice.reduce((s, c) => s + c.volume, 0) / slice.length;
}

// ------------------------------------------------------------
// Support / Resistance levels (swing highs/lows)
// Used by SR Flip and Liquidity Sweep strategies.
// ------------------------------------------------------------

export interface SwingLevel {
  price: number;
  timestamp: number;
  type: "HIGH" | "LOW";
  strength: number; // how many candles on each side confirmed it
}

/**
 * Identifies recent swing highs and lows by looking for a pivot
 * candle whose high/low is the extreme across `lookback` candles
 * on each side.
 */
export function calcSwingLevels(
  candles: Candle[],
  lookback: number = 5,
  maxLevels: number = 10
): SwingLevel[] {
  const levels: SwingLevel[] = [];
  const len = candles.length;

  for (let i = lookback; i < len - lookback; i++) {
    const pivot = candles[i];
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= pivot.high) isSwingHigh = false;
      if (candles[j].low <= pivot.low) isSwingLow = false;
    }

    if (isSwingHigh) {
      levels.push({
        price: pivot.high,
        timestamp: pivot.timestamp,
        type: "HIGH",
        strength: lookback,
      });
    }
    if (isSwingLow) {
      levels.push({
        price: pivot.low,
        timestamp: pivot.timestamp,
        type: "LOW",
        strength: lookback,
      });
    }
  }

  // Return the most recent `maxLevels` levels
  return levels.slice(-maxLevels);
}

/**
 * Finds the nearest swing level above or below current price
 * within a given proximity percentage.
 */
export function findNearestLevel(
  levels: SwingLevel[],
  price: number,
  proximityPct: number = 0.3
): SwingLevel | null {
  const threshold = price * (proximityPct / 100);
  let nearest: SwingLevel | null = null;
  let minDist = Infinity;

  for (const lvl of levels) {
    const dist = Math.abs(lvl.price - price);
    if (dist <= threshold && dist < minDist) {
      minDist = dist;
      nearest = lvl;
    }
  }
  return nearest;
}

// ------------------------------------------------------------
// Equal Highs / Equal Lows (Liquidity Pools)
// Used by Liquidity Sweep strategy.
// ------------------------------------------------------------

export interface LiquidityPool {
  price: number;
  type: "EQH" | "EQL"; // equal highs / equal lows
  touches: number;
  lastTimestamp: number;
}

/**
 * Detects clusters of nearly-equal highs or lows that represent
 * accumulated stop orders (liquidity pools).
 */
export function calcLiquidityPools(
  candles: Candle[],
  equalityThresholdPct: number = 0.05
): LiquidityPool[] {
  const pools: LiquidityPool[] = [];

  // Check recent 50 candles for equal highs/lows
  const slice = candles.slice(Math.max(0, candles.length - 50));

  const highs = slice.map((c) => ({ price: c.high, ts: c.timestamp }));
  const lows = slice.map((c) => ({ price: c.low, ts: c.timestamp }));

  const clusterize = (
    points: { price: number; ts: number }[],
    type: "EQH" | "EQL"
  ) => {
    const used = new Set<number>();
    for (let i = 0; i < points.length; i++) {
      if (used.has(i)) continue;
      const base = points[i].price;
      const threshold = base * (equalityThresholdPct / 100);
      const cluster = [i];

      for (let j = i + 1; j < points.length; j++) {
        if (Math.abs(points[j].price - base) <= threshold) {
          cluster.push(j);
          used.add(j);
        }
      }

      if (cluster.length >= 2) {
        const avgPrice =
          cluster.reduce((s, idx) => s + points[idx].price, 0) / cluster.length;
        const lastTs = Math.max(...cluster.map((idx) => points[idx].ts));
        pools.push({
          price: avgPrice,
          type,
          touches: cluster.length,
          lastTimestamp: lastTs,
        });
      }
    }
  };

  clusterize(highs, "EQH");
  clusterize(lows, "EQL");

  return pools;
}

// ------------------------------------------------------------
// Displacement candle detection
// A "displacement" is an abnormally large candle body relative
// to recent ATR — signals institutional aggression.
// ------------------------------------------------------------

export function isDisplacementCandle(
  candle: Candle,
  atr: number,
  multiplier: number = 1.5
): boolean {
  const body = Math.abs(candle.close - candle.open);
  return body >= atr * multiplier;
}

// ------------------------------------------------------------
// Master snapshot builder
// Combines all indicators into a single IndicatorSnapshot.
// `sessionCandles` = only candles from the current session (for VWAP).
// `allCandles`     = full history for EMA/RSI/ATR/BB accuracy.
// ------------------------------------------------------------

export function buildIndicatorSnapshot(
  allCandles: Candle[],
  sessionCandles: Candle[]
): IndicatorSnapshot {
  if (allCandles.length === 0) {
    throw new Error("buildIndicatorSnapshot: allCandles cannot be empty");
  }

  const closes = allCandles.map((c) => c.close);
  const lastCandle = allCandles[allCandles.length - 1];

  const ema = calcEMASnapshot(closes);
  const rsi14 = calcRSI(closes, 14);
  const atr14 = calcATR(allCandles, 14);
  const bollinger = calcBollinger(closes, 20, 2);
  const vwap = calcVWAP(sessionCandles.length > 0 ? sessionCandles : allCandles);
  const avgVolume20 = calcAvgVolume(allCandles, 20);
  const volumeMultiplier =
    avgVolume20 > 0 ? lastCandle.volume / avgVolume20 : 1;

  return {
    timestamp: lastCandle.timestamp,
    close: lastCandle.close,
    ema,
    rsi14,
    atr14,
    bollinger,
    vwap,
    volume: lastCandle.volume,
    avgVolume20,
    volumeMultiplier,
  };
}
