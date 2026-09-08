// ============================================================
// Core Types & Interfaces — Multi-Strategy Trading Bot
// ============================================================

// ------------------------------------------------------------
// Raw market data
// ------------------------------------------------------------

/** A single OHLCV candle as returned by CCXT */
export interface Candle {
  timestamp: number; // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ------------------------------------------------------------
// Indicator snapshots
// ------------------------------------------------------------

export interface EMASnapshot {
  ema9: number;
  ema21: number;
  ema50: number;
  ema200: number;
}

export interface BollingerSnapshot {
  upper: number;
  middle: number; // SMA-20
  lower: number;
  bandwidth: number;
  percentB: number; // (price - lower) / (upper - lower)
}

export interface VWAPSnapshot {
  vwap: number;
  deviationPct: number; // % distance of close from VWAP
}

/** Complete indicator state captured at signal evaluation */
export interface IndicatorSnapshot {
  timestamp: number;
  close: number;
  ema: EMASnapshot;
  rsi14: number;
  atr14: number;
  bollinger: BollingerSnapshot;
  vwap: VWAPSnapshot;
  volume: number;
  avgVolume20: number;
  volumeMultiplier: number; // volume / avgVolume20
}

// ------------------------------------------------------------
// Market flow classification
// ------------------------------------------------------------

export enum MarketFlow {
  IMPULSIVE_TREND_UP = "IMPULSIVE_TREND_UP",
  IMPULSIVE_TREND_DOWN = "IMPULSIVE_TREND_DOWN",
  PULLBACK_IN_UPTREND = "PULLBACK_IN_UPTREND",
  PULLBACK_IN_DOWNTREND = "PULLBACK_IN_DOWNTREND",
  KEY_LEVEL_TEST = "KEY_LEVEL_TEST",
  RANGE_BOUND = "RANGE_BOUND",
  LIQUIDITY_SWEEP = "LIQUIDITY_SWEEP",
  VWAP_EXTREME = "VWAP_EXTREME",
  UNDEFINED = "UNDEFINED",
}

export enum MacroBias {
  BULLISH = "BULLISH",
  BEARISH = "BEARISH",
  NEUTRAL = "NEUTRAL",
}

export interface FlowClassification {
  flow: MarketFlow;
  macroBias: MacroBias;       // derived from H1/H4
  h1Bias: MacroBias;
  h4Bias: MacroBias;
  confidence: number;          // 0–1
  timestamp: number;
}

// ------------------------------------------------------------
// Strategy definitions
// ------------------------------------------------------------

export enum StrategyId {
  TREND_PULLBACK_EMA = "TREND_PULLBACK_EMA",
  SR_FLIP_INVERSION = "SR_FLIP_INVERSION",
  BB_MEAN_REVERSION = "BB_MEAN_REVERSION",
  LIQUIDITY_SWEEP_REVERSAL = "LIQUIDITY_SWEEP_REVERSAL",
  VWAP_DEVIATION_REVERSAL = "VWAP_DEVIATION_REVERSAL",
}

export enum SignalDirection {
  LONG = "LONG",
  SHORT = "SHORT",
}

/** Output from an individual strategy's evaluate() call */
export interface StrategyResult {
  strategyId: StrategyId;
  triggered: boolean;
  direction: SignalDirection | null;
  score: number;              // 0–100 confidence/quality score
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  reason: string;             // human-readable rationale
  indicators: IndicatorSnapshot;
}

/** The winning signal selected by the flow classifier */
export interface Signal {
  id: string;                 // UUID
  timestamp: number;
  candleTimestamp: number;    // timestamp of the trigger candle
  symbol: string;
  strategyId: StrategyId;
  flow: FlowClassification;
  direction: SignalDirection;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskRewardRatio: number;    // always targeting 2R
  atr14: number;
  indicators: IndicatorSnapshot;
  allScores: Pick<StrategyResult, "strategyId" | "score" | "triggered" | "reason">[];
}

// ------------------------------------------------------------
// Order & trade lifecycle
// ------------------------------------------------------------

export enum OrderStatus {
  PENDING = "PENDING",
  OPEN = "OPEN",
  FILLED = "FILLED",
  CANCELLED = "CANCELLED",
  REJECTED = "REJECTED",
  CLOSED = "CLOSED",
}

export enum TradeOutcome {
  WIN = "WIN",
  LOSS = "LOSS",
  BREAKEVEN = "BREAKEVEN",
  OPEN = "OPEN",
  CANCELLED = "CANCELLED",
}

export interface Order {
  id: string;                 // UUID internal
  exchangeOrderId: string | null;
  symbol: string;
  direction: SignalDirection;
  size: number;               // units / contracts
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  status: OrderStatus;
  placedAt: number;           // Unix ms
  filledAt: number | null;
  closedAt: number | null;
  bybitTpId?: string;         // TP conditional Order ID (Bybit TP/SL tab)
  bybitSlId?: string;         // SL conditional Order ID (Bybit TP/SL tab)
}

export interface Trade {
  id: string;                 // UUID
  signalId: string;
  order: Order;
  symbol: string;
  strategyId: StrategyId;
  flow: FlowClassification;
  direction: SignalDirection;
  entryPrice: number;
  exitPrice: number | null;
  stopLoss: number;
  takeProfit: number;
  size: number;
  originalSize: number;
  originalStopLoss: number;
  partialTaken: boolean;
  partialExitPrice?: number;
  partialSize?: number;
  partialPnlRaw?: number;
  partialPnlR?: number;
  isBreakeven: boolean;
  pnlRaw: number | null;      // raw PnL in quote currency
  pnlR: number | null;        // PnL expressed in R multiples
  outcome: TradeOutcome;
  openedAt: number;
  closedAt: number | null;
  durationMs: number | null;
  indicators: IndicatorSnapshot;
  notes: string;
}

// ------------------------------------------------------------
// Evaluation log record (every candle evaluation, win or miss)
// ------------------------------------------------------------

export interface EvaluationRecord {
  id: string;
  timestamp: number;
  symbol: string;
  candleTimestamp: number;
  flow: FlowClassification;
  strategyScores: Pick<StrategyResult, "strategyId" | "score" | "triggered" | "reason">[];
  winningStrategy: StrategyId | null;
  signalFired: boolean;
  signal: Signal | null;
  indicators: IndicatorSnapshot;
  sessionActive: boolean;
}

// ------------------------------------------------------------
// Bot configuration
// ------------------------------------------------------------

export interface BotConfig {
  symbol: string;
  timeframe: string;          // "5m"
  riskPerTradePct: number;    // e.g. 0.01 = 1% of account
  riskRewardRatio: number;    // 2
  atrMultiplierSL: number;    // e.g. 1.5 × ATR for stop distance
  sessionStartUTC: number;    // 13 (13:00 UTC)
  sessionEndUTC: number;      // 21 (21:00 UTC)
  h1Timeframe: string;        // "1h"
  h4Timeframe: string;        // "4h"
  minVolumeMultiplier: number; // minimum vol vs 20-period avg
  maxOpenTrades: number;
  paperTrading: boolean;
  paperBalance: number;       // virtual account size for paper trading sizing
  enableEarlyPartials: boolean;
  partialTPR: number;          // e.g. 0.5 for +0.5R early take-profit
  partialClosePct: number;     // e.g. 0.5 to close 50% size
  breakevenBufferR: number;    // e.g. 0.05R to cover exchange fees
}
