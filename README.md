# Multi-Strategy Automated Trading Bot

A modular, production-ready Node.js/TypeScript trading bot that runs five
distinct strategies through a real-time flow classifier, executes strictly on
closed M5 candles during the New York session, and maintains a comprehensive
structured audit trail of every decision.

---

## Architecture Overview

```
src/
├── index.ts                  # Entry point & orchestrator
├── types/index.ts            # All shared types & interfaces
├── indicators/index.ts       # Pure indicator functions (EMA, ATR, RSI, BB, VWAP)
├── strategies/
│   ├── base.ts               # Strategy interface & StrategyContext
│   ├── trendPullbackEMA.ts   # Strategy 1: EMA Confluence Pullback
│   ├── srFlipInversion.ts    # Strategy 2: S/R Flip Retest
│   ├── bbMeanReversion.ts    # Strategy 3: Bollinger Band Mean Reversion
│   ├── liquiditySweepReversal.ts # Strategy 4: Liquidity Sweep Reversal
│   ├── vwapDeviationReversal.ts  # Strategy 5: VWAP Deviation Reversal
│   └── index.ts              # Registry / barrel export
├── classifier/
│   └── flowClassifier.ts     # Flow gatekeeper — H1/H4 bias + M5 state + scorer
├── execution/
│   └── executionEngine.ts    # Sizing, order placement, SL/TP tracking
└── logger/
    └── logger.ts             # Winston console + NDJSON structured ledger
```

---

## Strategies

| # | Strategy | Best Flow | Direction Logic |
|---|---|---|---|
| 1 | **Trend Pullback EMA** | Pullback in trend | EMA9/21/50 aligned, price returns to EMA9/21 zone, RSI not extreme |
| 2 | **S/R Flip Inversion** | Key Level Test | Broken swing level retested from opposite side with rejection candle |
| 3 | **BB Mean Reversion** | Range Bound | Close outside band + RSI extreme, next close back inside band |
| 4 | **Liquidity Sweep Reversal** | Any / Liquidity Sweep | EQH/EQL pool swept by wick, large displacement candle closes back |
| 5 | **VWAP Deviation Reversal** | VWAP Extreme / Range | Price ≥0.3% from session VWAP + RSI extreme + rejection candle |

All strategies return a **score 0–100**. The Flow Classifier selects the
single highest-scoring triggered strategy per candle (minimum score: 65).

---

## Flow Classifier States

```
IMPULSIVE_TREND_UP / DOWN   — strong EMA slope + RSI momentum
PULLBACK_IN_UPTREND / DOWN  — aligned EMAs, price near EMA9 zone
KEY_LEVEL_TEST              — price within 0.6×ATR of a swing level
RANGE_BOUND                 — compressed ATR + tight EMA spread
LIQUIDITY_SWEEP             — wick beyond EQH/EQL + close reversal
VWAP_EXTREME                — price ≥0.3% from session VWAP
UNDEFINED                   — no clear state
```

Macro bias (BULLISH / BEARISH / NEUTRAL) is derived independently from H4
candles (primary) and H1 candles (secondary). Conflicting H4 vs H1 = NEUTRAL.

---

## Risk Management

- **Stop-loss**: `entry ± ATR(14) × ATR_MULTIPLIER_SL` (dynamic, not fixed)
- **Take-profit**: `stopDistance × RISK_REWARD_RATIO` (hardcoded 2R)
- **Position size**: `(balance × RISK_PER_TRADE_PCT) / stopDistance`
- **Execution lock**: one order per 5-minute candle block (no spam)
- **Max open trades**: configurable guard (default: 2)
- **Session close**: all open trades force-closed at 21:00 UTC

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your exchange API credentials
```

### 3. Build

```bash
npm run build
```

### 4. Run (paper trading — default)

```bash
npm start
```

Or run directly with ts-node during development:

```bash
npm run dev
```

---

## Log Files

All logs are written to the `logs/` directory (auto-created on first run).

| File | Contents |
|---|---|
| `bot.log` | Rotating Winston runtime log (10 MB × 5 files) |
| `evaluations-YYYY-MM-DD.ndjson` | Every M5 candle: flow state, all 5 strategy scores, indicator snapshot |
| `signals-YYYY-MM-DD.ndjson` | Every fired signal: full indicator state, entry/SL/TP, strategy attribution |
| `trades-YYYY-MM-DD.ndjson` | Every trade open and close: PnL in raw + R multiples |
| `session-summaries.ndjson` | Per-session summary: win/loss/BE, total R, per-strategy breakdown |

NDJSON (newline-delimited JSON) — each line is a valid JSON object. Load
directly into pandas, DuckDB, or any JSON-aware tool for analysis:

```python
import pandas as pd
df = pd.read_json("logs/trades-2025-06-01.ndjson", lines=True)
```

---

## Going Live

> **Run in paper trading mode for a minimum of 4–6 weeks before enabling live
> trading. Validate strategy attribution, R expectancy, and drawdown in the
> structured logs before committing real capital.**

To enable live trading:

1. Set `PAPER_TRADING=false` in `.env`
2. Replace testnet API keys with live keys
3. Verify your exchange supports `stop_market` and `take_profit_market` order
   types for the selected symbol (futures only)
4. Start with a small position size (`RISK_PER_TRADE_PCT=0.005`)

---

## Extending the Bot

**Adding a new strategy:**
1. Create `src/strategies/myStrategy.ts` implementing `Strategy`
2. Export it from `src/strategies/index.ts`
3. Add an instance to `buildStrategyRegistry()`
4. Add the new `StrategyId` to `src/types/index.ts`

**Adding a new flow state:**
1. Add the value to `MarketFlow` enum in `src/types/index.ts`
2. Add detection logic in `classifyM5Flow()` inside `flowClassifier.ts`
3. Update any strategy `EXCLUDED_FLOWS` sets if needed

---

## Dependencies

| Package | Purpose |
|---|---|
| `ccxt` | Exchange connectivity (100+ exchanges) |
| `dotenv` | Environment variable loading |
| `winston` | Structured logging |
| `uuid` | Unique IDs for trades, signals, evaluations |
| `typescript` | Type safety |
| `ts-node` | Dev-time execution without build step |
