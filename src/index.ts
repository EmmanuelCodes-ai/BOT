// ============================================================
// Bot Entry Point — Orchestrator
//
// Boot sequence:
//   1. Load config from environment
//   2. Connect to exchange (sandbox or live)
//   3. Wire up all subsystems
//   4. Enter the main loop — polls for new closed M5 candles
//      within the NY session window (13:00–21:00 UTC)
//   5. On each new closed candle:
//      a. Fetch H1/H4 context candles
//      b. Run FlowClassifier → get signal or null
//      c. Log the evaluation record
//      d. If signal: log it, attempt execution
//      e. Check all open trades for SL/TP hits
//   6. On session end: force-close open trades + log summary
//   7. Graceful shutdown on SIGINT/SIGTERM
// ============================================================

import "dotenv/config";
import ccxt, { Exchange } from "ccxt";
import { BotConfig, Candle, EvaluationRecord } from "./types";
import { FlowClassifier } from "./classifier";
import { ExecutionEngine } from "./execution";
import { BotLogger } from "./logger";
import { buildStrategyRegistry } from "./strategies";
import { startHealthServer } from "./healthCheck";
import { v4 as uuidv4 } from "uuid";

// ============================================================
// 1. Load & validate configuration
// ============================================================

function loadConfig(): BotConfig {
  const required = [
    "EXCHANGE_ID",
    "API_KEY",
    "API_SECRET",
    "SYMBOL",
  ];

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  return {
    symbol: process.env.SYMBOL!,
    timeframe: process.env.TIMEFRAME ?? "5m",
    riskPerTradePct: parseFloat(process.env.RISK_PER_TRADE_PCT ?? "0.01"),
    riskRewardRatio: parseFloat(process.env.RISK_REWARD_RATIO ?? "2"),
    atrMultiplierSL: parseFloat(process.env.ATR_MULTIPLIER_SL ?? "1.5"),
    sessionStartUTC: parseInt(process.env.SESSION_START_UTC ?? "13", 10),
    sessionEndUTC: parseInt(process.env.SESSION_END_UTC ?? "21", 10),
    h1Timeframe: "1h",
    h4Timeframe: "4h",
    minVolumeMultiplier: parseFloat(process.env.MIN_VOLUME_MULTIPLIER ?? "0.8"),
    maxOpenTrades: parseInt(process.env.MAX_OPEN_TRADES ?? "2", 10),
    paperTrading: process.env.PAPER_TRADING !== "false", // default true
  };
}

// ============================================================
// 2. Exchange factory
// ============================================================

function buildExchange(config: BotConfig): Exchange {
  const exchangeId = process.env.EXCHANGE_ID!;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ExchangeClass = (ccxt as any)[exchangeId];
  if (!ExchangeClass) {
    throw new Error(`Unknown CCXT exchange: ${exchangeId}`);
  }

  // Bybit Demo Trading uses a dedicated stable endpoint on mainnet infrastructure.
  // It is strongly preferred over the unreliable testnet.
  // Enable by setting BYBIT_DEMO_MODE=true and using demo API keys from
  // bybit.com → switch to Demo Trading → API Management.
  const isDemoMode =
    process.env.BYBIT_DEMO_MODE === "true" &&
    process.env.EXCHANGE_ID === "bybit";

  const exchange: Exchange = new ExchangeClass({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: {
      defaultType: process.env.MARKET_TYPE ?? "future",
      fetchCurrencies: false,   // skip coin/query-info — slow and not needed
      ...(isDemoMode && { demo: true }),
    },
  });

  // Force-disable fetchCurrencies at the instance level.
  // CCXT's bybit ignores the options flag and always calls coin/query-info
  // during loadMarkets — overriding the method is the only reliable fix.
  (exchange as any).fetchCurrencies = async () => ({});

  // SANDBOX_MODE controls whether to hit the exchange testnet endpoint.
  // Only enable if you specifically have testnet credentials.
  // Prefer BYBIT_DEMO_MODE=true over SANDBOX_MODE=true for Bybit.
  const sandboxMode = process.env.SANDBOX_MODE === "true";
  if (sandboxMode) {
    exchange.setSandboxMode(true);
  }

  return exchange;
}

// ============================================================
// 3. CCXT candle fetching helpers
// ============================================================

/**
 * Fetches the most recent `limit` closed candles for a given timeframe.
 * CCXT returns [timestamp, open, high, low, close, volume].
 * We request limit+1 and drop the last (potentially open) candle.
 */
async function fetchClosedCandles(
  exchange: Exchange,
  symbol: string,
  timeframe: string,
  limit: number
): Promise<Candle[]> {
  const raw = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit + 1);
  // Drop the last candle — it may still be forming
  const closed = raw.slice(0, -1);
  return closed.map((c) => ({
    timestamp: c[0] as number,
    open: c[1] as number,
    high: c[2] as number,
    low: c[3] as number,
    close: c[4] as number,
    volume: c[5] as number,
  }));
}

// ============================================================
// 4. Session window helpers
// ============================================================

/** Returns true when current UTC hour is inside the trading session */
function isInsideSession(startHour: number, endHour: number): boolean {
  const hour = new Date().getUTCHours();
  return hour >= startHour && hour < endHour;
}

/** Returns true when current UTC hour is exactly the session end hour */
function isSessionEnd(endHour: number): boolean {
  const now = new Date();
  return now.getUTCHours() === endHour && now.getUTCMinutes() === 0;
}

// ============================================================
// 5. Filter session candles (for rolling VWAP)
// ============================================================

function filterSessionCandles(
  candles: Candle[],
  sessionStartHour: number
): Candle[] {
  const now = new Date();
  const sessionStartToday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    sessionStartHour,
    0,
    0,
    0
  );
  return candles.filter((c) => c.timestamp >= sessionStartToday);
}

// ============================================================
// 6. Main loop
// ============================================================

class TradingBot {
  private config: BotConfig;
  private exchange: Exchange;
  private classifier: FlowClassifier;
  private engine: ExecutionEngine;
  private logger: BotLogger;

  private lastProcessedCandleTs: number = 0;
  private sessionStartTs: number = 0;
  private running: boolean = false;

  constructor(
    config: BotConfig,
    exchange: Exchange,
    classifier: FlowClassifier,
    engine: ExecutionEngine,
    logger: BotLogger
  ) {
    this.config = config;
    this.exchange = exchange;
    this.classifier = classifier;
    this.engine = engine;
    this.logger = logger;

    // Wire trade events to logger
    this.engine.onTradeUpdate = (trade) => this.logger.logTrade(trade);
  }

  async start(): Promise<void> {
    this.running = true;
    this.logger.info("Bot started", {
      symbol: this.config.symbol,
      paperTrading: this.config.paperTrading,
      session: `${this.config.sessionStartUTC}:00–${this.config.sessionEndUTC}:00 UTC`,
    });

    // Register graceful shutdown
    process.on("SIGINT", () => this.shutdown("SIGINT"));
    process.on("SIGTERM", () => this.shutdown("SIGTERM"));

    await this.loop();
  }

  private async loop(): Promise<void> {
    const POLL_INTERVAL_MS = 15_000; // check every 15 seconds

    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        this.logger.error("Unhandled error in main loop tick", {
          error: String(err),
        });
      }

      // Wait before next poll
      await sleep(POLL_INTERVAL_MS);
    }
  }

  private async tick(): Promise<void> {
    const now = new Date();

    // ── Session end — force-close and summarise ────────────
    if (isSessionEnd(this.config.sessionEndUTC) && this.sessionStartTs > 0) {
      this.logger.info("Session end reached — closing all open trades");
      const lastPrice = await this.fetchLastPrice();
      this.engine.closeAllAtMarket(lastPrice, "Session end 21:00 UTC");

      this.logger.logSessionSummary(
        this.engine.getClosedTrades(),
        this.sessionStartTs,
        Date.now()
      );

      this.sessionStartTs = 0; // reset for next session
      return;
    }

    // ── Outside session window — idle ─────────────────────
    if (!isInsideSession(this.config.sessionStartUTC, this.config.sessionEndUTC)) {
      this.logger.debug(
        `Outside session window (${now.getUTCHours()}:${String(now.getUTCMinutes()).padStart(2, "0")} UTC) — waiting`
      );
      return;
    }

    // Mark session start for the summary
    if (this.sessionStartTs === 0) {
      this.sessionStartTs = Date.now();
      this.logger.info("Session opened", {
        utcTime: now.toISOString(),
      });
    }

    // ── Fetch candles ──────────────────────────────────────
    // 300 M5 candles ≈ 25 hours — enough for all indicators
    const m5Candles = await fetchClosedCandles(
      this.exchange,
      this.config.symbol,
      this.config.timeframe,
      300
    );

    if (m5Candles.length < 50) {
      this.logger.warn("Insufficient M5 candles returned", {
        count: m5Candles.length,
      });
      return;
    }

    const latestCandle = m5Candles[m5Candles.length - 1];

    // ── Deduplication — skip if we've already processed this candle ──
    if (latestCandle.timestamp <= this.lastProcessedCandleTs) {
      return; // same candle, wait for the next close
    }

    this.logger.debug(
      `New M5 candle: ${new Date(latestCandle.timestamp).toISOString()} close=${latestCandle.close}`
    );

    // ── Fetch H1 / H4 context (100 candles each) ──────────
    const [h1Candles, h4Candles] = await Promise.all([
      fetchClosedCandles(this.exchange, this.config.symbol, this.config.h1Timeframe, 100),
      fetchClosedCandles(this.exchange, this.config.symbol, this.config.h4Timeframe, 100),
    ]);

    // ── Session VWAP candles ───────────────────────────────
    const sessionCandles = filterSessionCandles(
      m5Candles,
      this.config.sessionStartUTC
    );

    // ── Check open trades first ────────────────────────────
    this.engine.checkOpenTrades(latestCandle);

    // ── Run flow classifier ────────────────────────────────
    const output = this.classifier.classify(
      m5Candles,
      h1Candles,
      h4Candles,
      sessionCandles,
      this.config.atrMultiplierSL,
      this.config.riskRewardRatio,
      this.config.symbol
    );

    // ── Build evaluation record ────────────────────────────
    const evalRecord: EvaluationRecord = {
      id: uuidv4(),
      timestamp: Date.now(),
      symbol: this.config.symbol,
      candleTimestamp: latestCandle.timestamp,
      flow: output.flow,
      strategyScores: output.results.map((r) => ({
        strategyId: r.strategyId,
        score: r.score,
        triggered: r.triggered,
        reason: r.reason,
      })),
      winningStrategy: output.winner?.strategyId ?? null,
      signalFired: output.signal !== null,
      signal: output.signal,
      indicators: output.indicators,
      sessionActive: true,
    };

    this.logger.logEvaluation(evalRecord);

    // ── Execute signal if present ──────────────────────────
    if (output.signal) {
      this.logger.logSignal(output.signal);

      const trade = await this.engine.execute(
        output.signal,
        latestCandle.timestamp
      );

      if (trade) {
        this.logger.info("Trade execution confirmed", {
          tradeId: trade.id.slice(0, 8),
          strategy: trade.strategyId,
        });
      }
    }

    // ── Mark candle as processed ───────────────────────────
    this.lastProcessedCandleTs = latestCandle.timestamp;
  }

  private async fetchLastPrice(): Promise<number> {
    try {
      const ticker = await this.exchange.fetchTicker(this.config.symbol);
      return ticker.last ?? ticker.close ?? 0;
    } catch {
      const m5 = await fetchClosedCandles(
        this.exchange,
        this.config.symbol,
        this.config.timeframe,
        2
      );
      return m5[m5.length - 1]?.close ?? 0;
    }
  }

  private async shutdown(signal: string): Promise<void> {
    this.logger.info(`Shutdown signal received: ${signal}`);
    this.running = false;

    if (this.engine.getOpenTradeCount() > 0) {
      this.logger.warn("Closing open trades before shutdown...");
      const lastPrice = await this.fetchLastPrice().catch(() => 0);
      if (lastPrice > 0) {
        this.engine.closeAllAtMarket(lastPrice, `Shutdown: ${signal}`);
      }
    }

    if (this.engine.getClosedTrades().length > 0 && this.sessionStartTs > 0) {
      this.logger.logSessionSummary(
        this.engine.getClosedTrades(),
        this.sessionStartTs,
        Date.now()
      );
    }

    this.logger.info("Bot shut down cleanly");
    process.exit(0);
  }
}

// ============================================================
// 7. Bootstrap
// ============================================================

async function main(): Promise<void> {
  // Start health check server immediately so Render marks the service as live
  const healthPort = parseInt(process.env.PORT ?? "3000", 10);
  startHealthServer(healthPort);

  const config = loadConfig();
  const exchange = buildExchange(config);
  const logger = new BotLogger();

  logger.info("Connecting to exchange...", {
    exchange: process.env.EXCHANGE_ID,
    demoMode: process.env.BYBIT_DEMO_MODE === "true",
    paperTrading: config.paperTrading,
  });

  // Load markets — skip fetchCurrencies (coin/query-info) which is slow/unreliable.
  // We only need the market symbols, not full currency metadata.
  await exchange.loadMarkets();
  logger.info("Markets loaded");

  const strategies = buildStrategyRegistry();
  const classifier = new FlowClassifier(strategies);
  const engine = new ExecutionEngine(exchange, config);

  const bot = new TradingBot(config, exchange, classifier, engine, logger);
  await bot.start();
}

main().catch((err) => {
  console.error("Fatal error during startup:", err);
  process.exit(1);
});

// ── Utility ───────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
