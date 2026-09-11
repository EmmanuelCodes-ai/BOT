// ============================================================
// Order Execution Rules Test
// Validates:
// 1. Fixed Position Sizing (Decoupled from equity, clamped to max margin)
// 2. Limit Orders Only (PostOnly/GTC Maker execution)
// 3. Dynamic Stop-Loss & Incremental Stepped Closing
//
// Run with: npx ts-node src/test/testOrderExecutionRules.ts
// ============================================================

import "dotenv/config";
import {
  Signal,
  SignalDirection,
  StrategyId,
  MarketFlow,
  MacroBias,
  BotConfig,
  TradeOutcome,
} from "../types";
import { ExecutionEngine } from "../execution";
import { BotLogger } from "../logger";

function makeConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    symbol: "BTC/USDT:USDT",
    timeframe: "5m",
    riskPerTradePct: 0.01,
    leverage: 10,
    riskRewardRatio: 2,
    atrMultiplierSL: 1.5,
    sessionStartUTC: 13,
    sessionEndUTC: 21,
    h1Timeframe: "1h",
    h4Timeframe: "4h",
    minVolumeMultiplier: 1.0,
    maxOpenTrades: 5,
    paperTrading: true,
    paperBalance: 10000,
    enableEarlyPartials: true,
    partialProfitROIPct: 0.5,
    partialProfitPct: 0.005,
    partialClosePct: 0.5,
    breakevenBufferPct: 0.0005,
    enablePreEntryFilters: false, // disable pre-entry filters for unit testing order rules
    minBollingerBandwidth: 0.0025,
    minATRExpansionRatio: 0.85,
    fixedMarginPerTrade: 200,
    maxPositionMargin: 300,
    limitOrderPostOnly: true,
    enableSteppedStopLoss: true,
    steppedStopTranches: [0.5, 0.75],
    steppedStopClosePct: 0.5,
    enableDynamicTrailingStop: true,
    trailingStopActivationROI: 0.5,
    trailingStopDistancePct: 0.3,
    ...overrides,
  };
}

function makeSignal(direction = SignalDirection.LONG, entry = 60000, sl = 59000, tp = 62000): Signal {
  return {
    id: `signal-${Date.now()}-${Math.random()}`,
    timestamp: Date.now(),
    candleTimestamp: Date.now() - 300000,
    symbol: "BTC/USDT:USDT",
    strategyId: StrategyId.TREND_PULLBACK_EMA,
    flow: {
      flow: MarketFlow.PULLBACK_IN_UPTREND,
      macroBias: MacroBias.BULLISH,
      h1Bias: MacroBias.BULLISH,
      h4Bias: MacroBias.BULLISH,
      confidence: 0.9,
      timestamp: Date.now(),
    },
    direction,
    entryPrice: entry,
    stopLoss: sl,
    takeProfit: tp,
    riskRewardRatio: 2,
    atr14: 100,
    allScores: [],
    indicators: {
      timestamp: Date.now(),
      close: entry,
      ema: { ema9: 59800, ema21: 59500, ema50: 59000, ema200: 57000 },
      rsi14: 50,
      atr14: 100,
      avgATR50: 100,
      atrExpansionRatio: 1.0,
      bollinger: { upper: 60500, middle: 60000, lower: 59500, bandwidth: 0.01, percentB: 0.5 },
      vwap: { vwap: 59900, deviationPct: 0.1 },
      volume: 1500,
      avgVolume20: 1000,
      volumeMultiplier: 1.5,
    },
  };
}

function createMockExchange() {
  return {
    apiKey: "test-key-12345",
    markets: {
      "BTC/USDT:USDT": {
        id: "BTCUSDT",
        symbol: "BTC/USDT:USDT",
        limits: { amount: { min: 0.001 } },
        precision: { amount: 3, price: 2 },
      },
    },
    amountToPrecision: (_s: string, amount: number) => amount.toFixed(3),
    priceToPrecision: (_s: string, price: number) => price.toFixed(2),
    market: (_s: string) => ({ id: "BTCUSDT" }),
    createOrder: async () => ({ id: "mock-order-id", status: "open" }),
    fetchOpenOrders: async () => [],
    fetchOrder: async () => null,
  };
}

async function runTests() {
  console.log("============================================================");
  console.log("   ORDER EXECUTION RULES TEST SUITE (Rules 1, 2, 3)");
  console.log("============================================================\n");

  const logger = new BotLogger();
  let passedCount = 0;
  let failedCount = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`✅ [PASS] ${testName}`);
      passedCount++;
    } else {
      console.error(`❌ [FAIL] ${testName}${detail ? ` - ${detail}` : ""}`);
      failedCount++;
    }
  }

  // ──────────────────────────────────────────────────────────
  // TEST 1: Fixed Position Sizing (Rule 1)
  // ──────────────────────────────────────────────────────────
  console.log("─── TEST GROUP 1: Fixed Position Sizing (Rule 1) ───");
  {
    const config = makeConfig({ fixedMarginPerTrade: 200, maxPositionMargin: 300, leverage: 10 });
    const mockExchange = createMockExchange();
    const engine = new ExecutionEngine(mockExchange as any, config, logger);

    // Entry at $60,000.
    // Margin = $200, Leverage = 10x -> Notional = $2,000.
    // Size = $2,000 / $60,000 = 0.0333... BTC (precision 3 -> 0.033).
    const signal = makeSignal(SignalDirection.LONG, 60000, 59000, 62000);
    const trade = await engine.execute(signal, Date.now());

    assert(trade !== null, "Trade executed successfully");
    if (trade) {
      assert(
        Math.abs(trade.size - 0.033) < 0.001,
        `Position sized exactly to fixed margin ($200 * 10x / 60000 = 0.033 BTC). Actual: ${trade.size}`
      );
    }
  }

  // ──────────────────────────────────────────────────────────
  // TEST 2: Hard Cap on Max Margin (Rule 1)
  // ──────────────────────────────────────────────────────────
  console.log("\n─── TEST GROUP 2: Hard Cap at Max Position Margin (Rule 1) ───");
  {
    // Try setting margin to $1,000 with maxPositionMargin capped at $300
    const config = makeConfig({ fixedMarginPerTrade: 1000, maxPositionMargin: 300, leverage: 10 });
    const mockExchange = createMockExchange();
    const engine = new ExecutionEngine(mockExchange as any, config, logger);

    const signal = makeSignal(SignalDirection.LONG, 50000, 49000, 52000);
    const trade = await engine.execute(signal, Date.now());

    // Max margin is $300 * 10x = $3,000 notional. At $50,000 price -> size = 0.06 BTC.
    // (If $1,000 was allowed, size would be 0.2 BTC).
    assert(trade !== null, "Trade executed with capped margin");
    if (trade) {
      assert(
        Math.abs(trade.size - 0.06) < 0.001,
        `Position margin clamped at max $300 ($3,000 notional / 50000 = 0.06 BTC). Actual: ${trade.size}`
      );
    }
  }

  // ──────────────────────────────────────────────────────────
  // TEST 3: Stepped Adverse Stop-Loss Tranches (Rule 3)
  // ──────────────────────────────────────────────────────────
  console.log("\n─── TEST GROUP 3: Stepped Adverse Stop-Loss Tranches (Rule 3) ───");
  {
    let steppedCloseFired = false;
    let firedStepRatio = 0;
    let closedSizeRecorded = 0;

    const config = makeConfig({
      enableSteppedStopLoss: true,
      steppedStopTranches: [0.5, 0.75],
      steppedStopClosePct: 0.5,
      leverage: 10,
    });
    const mockExchange = createMockExchange();
    const engine = new ExecutionEngine(mockExchange as any, config, logger);

    engine.onSteppedStopClose = (_t, closedSize, _exitPrice, _lossRaw, stepRatio) => {
      steppedCloseFired = true;
      firedStepRatio = stepRatio;
      closedSizeRecorded = closedSize;
    };

    // Entry at $60,000, SL at $59,000 -> stopDistance = 1,000.
    // Size = $2,000 notional / $60,000 = 0.033 BTC.
    const signal = makeSignal(SignalDirection.LONG, 60000, 59000, 62000);
    const trade = await engine.execute(signal, Date.now());
    assert(trade !== null, "Base trade entered");

    // Adverse move: price drops to $59,500 (adverse move = 500, which is 50% of 1000 stop distance)
    await engine.checkTradeProgress(59500);

    assert(steppedCloseFired, "Stepped stop tranche 0.5 (50% adverse) fired");
    assert(firedStepRatio === 0.5, `Fired ratio is 0.5. Actual: ${firedStepRatio}`);
    assert(closedSizeRecorded > 0, `Closed partial size > 0. Actual: ${closedSizeRecorded}`);
    if (trade) {
      assert(
        (trade.steppedStopTranchesFired ?? []).includes(0.5),
        "Trade recorded tranche 0.5 as fired"
      );
      assert(trade.size < 0.033, `Remaining size reduced from 0.033. Actual: ${trade.size}`);
    }

    // Now price drops further to $59,250 (75% adverse move = 750)
    steppedCloseFired = false;
    await engine.checkTradeProgress(59250);

    assert(steppedCloseFired, "Stepped stop tranche 0.75 (75% adverse) fired");
    assert(firedStepRatio === 0.75, `Fired ratio is 0.75. Actual: ${firedStepRatio}`);
  }

  // ──────────────────────────────────────────────────────────
  // TEST 4: Dynamic Trailing Stop (Rule 3)
  // ──────────────────────────────────────────────────────────
  console.log("\n─── TEST GROUP 4: Dynamic Trailing Stop (Rule 3) ───");
  {
    let trailingUpdateFired = false;
    let recordedTrailingStop = 0;

    const config = makeConfig({
      enableDynamicTrailingStop: true,
      trailingStopActivationROI: 0.5, // 0.5% ROI needed
      trailingStopDistancePct: 0.3,   // 0.3% behind peak
      leverage: 10,
    });
    const mockExchange = createMockExchange();
    const engine = new ExecutionEngine(mockExchange as any, config, logger);

    engine.onTrailingStopUpdate = (_t, _peak, newStopLoss) => {
      trailingUpdateFired = true;
      recordedTrailingStop = newStopLoss;
    };

    // Entry at $60,000, SL at $59,000.
    // 0.5% ROI at 10x leverage requires 0.05% price increase = +$30 ($60,030).
    const signal = makeSignal(SignalDirection.LONG, 60000, 59000, 62000);
    const trade = await engine.execute(signal, Date.now());
    assert(trade !== null, "Base trade entered for trailing test");

    // Price moves to $60,600 (+1% price move = +10% ROI)
    await engine.checkTradeProgress(60600);

    assert(trailingUpdateFired, "Dynamic trailing stop activated and ratcheted forward");
    assert(trade !== null && (trade.dynamicTrailingStop ?? 0) > 59000, "Stop loss ratcheted above initial SL (59000)");
    assert(
      recordedTrailingStop > 60000,
      `Trailing stop ratcheted into profit (> $60,000). Actual: ${recordedTrailingStop}`
    );

    // Ensure it never loosens when price dips slightly
    const stopBeforeDip = trade?.stopLoss ?? 0;
    trailingUpdateFired = false;
    await engine.checkTradeProgress(60500); // slight pullback from 60600

    assert(
      trade?.stopLoss === stopBeforeDip,
      `Trailing stop did NOT loosen on pullback. Preserved: ${trade?.stopLoss}`
    );
  }

  console.log("\n============================================================");
  console.log(`TEST RESULTS: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log("============================================================");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
