// ============================================================
// Logger
//
// Two distinct output streams:
//
//   1. Console (Winston) — human-readable, colour-coded runtime log
//      INFO  : normal bot lifecycle events
//      WARN  : skipped signals, lock blocks, guard trips
//      ERROR : exchange errors, unexpected exceptions
//
//   2. Structured JSON ledger — one record per file, newline-delimited
//      logs/evaluations.ndjson  — every M5 candle evaluation
//      logs/trades.ndjson       — every trade open + update + close
//      logs/signals.ndjson      — every fired signal (pre-execution)
//
// Files rotate daily: evaluations-2025-06-01.ndjson, etc.
// ============================================================

import winston from "winston";
import * as fs from "fs";
import * as path from "path";
import { Trade, Signal, EvaluationRecord } from "../types";

// ── Log directory ──────────────────────────────────────────
const LOG_DIR = path.resolve(process.cwd(), "logs");

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

// ── Daily filename helper ──────────────────────────────────
function dailyFilename(prefix: string): string {
  const d = new Date();
  const dateStr = d.toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `${prefix}-${dateStr}.ndjson`);
}

// ── Append a single JSON record to an NDJSON file ─────────
function appendRecord(filepath: string, record: unknown): void {
  try {
    const line = JSON.stringify(record) + "\n";
    fs.appendFileSync(filepath, line, "utf8");
  } catch (err) {
    // Don't let a logging failure crash the bot
    console.error(`[Logger] Failed to write to ${filepath}:`, err);
  }
}

// ============================================================
// Winston console transport
// ============================================================

const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({ format: "HH:mm:ss" }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const extra =
      Object.keys(meta).length > 0
        ? " " + JSON.stringify(meta, null, 0)
        : "";
    return `[${timestamp}] ${level}: ${message}${extra}`;
  })
);

const winstonLogger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, "bot.log"),
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
      tailable: true,
    }),
  ],
});

// ============================================================
// BotLogger — structured ledger on top of Winston
// ============================================================

export class BotLogger {
  constructor() {
    ensureLogDir();
    winstonLogger.info("Logger initialised", { logDir: LOG_DIR });
  }

  // ── Console / runtime logging ────────────────────────────

  info(message: string, meta?: Record<string, unknown>): void {
    winstonLogger.info(message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    winstonLogger.warn(message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    winstonLogger.error(message, meta);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    winstonLogger.debug(message, meta);
  }

  // ── Structured ledger: evaluations ──────────────────────

  /**
   * Called every M5 candle close regardless of whether a signal fires.
   * Captures the full flow + all strategy scores for post-analysis.
   */
  logEvaluation(record: EvaluationRecord): void {
    appendRecord(dailyFilename("evaluations"), {
      ...record,
      _loggedAt: new Date().toISOString(),
    });

    const tag = record.signalFired
      ? `SIGNAL → ${record.winningStrategy}`
      : "no signal";
    winstonLogger.info(
      `[Eval] ${new Date(record.timestamp).toISOString()} | Flow=${record.flow.flow} | ${tag}`,
      {
        scores: record.strategyScores.map((s) => `${s.strategyId}:${s.score}`),
      }
    );
  }

  // ── Structured ledger: signals ───────────────────────────

  /**
   * Logged immediately when the classifier selects a winning signal,
   * before the execution engine acts on it.
   */
  logSignal(signal: Signal): void {
    appendRecord(dailyFilename("signals"), {
      ...signal,
      _loggedAt: new Date().toISOString(),
    });

    winstonLogger.info(
      `[Signal] ${signal.strategyId} | ${signal.direction} ${signal.symbol} @ ${signal.entryPrice}`,
      {
        id: signal.id.slice(0, 8),
        sl: signal.stopLoss,
        tp: signal.takeProfit,
        rrr: signal.riskRewardRatio,
        flow: signal.flow.flow,
        bias: signal.flow.macroBias,
        atr: signal.atr14.toFixed(5),
        rsi: signal.indicators.rsi14.toFixed(1),
        vwapDev: signal.indicators.vwap.deviationPct.toFixed(3) + "%",
        volMul: signal.indicators.volumeMultiplier.toFixed(2),
      }
    );
  }

  // ── Structured ledger: trades ────────────────────────────

  /**
   * Called on every trade state change:
   *   - when a trade is opened (outcome = OPEN)
   *   - when a trade is closed (outcome = WIN / LOSS / BREAKEVEN)
   * The execution engine fires onTradeUpdate → this method.
   */
  logTrade(trade: Trade): void {
    appendRecord(dailyFilename("trades"), {
      ...trade,
      _loggedAt: new Date().toISOString(),
    });

    const isOpen = trade.outcome === "OPEN";

    if (isOpen) {
      winstonLogger.info(
        `[Trade OPEN]  ${trade.id.slice(0, 8)} | ${trade.direction} ${trade.symbol} @ ${trade.entryPrice} | SL=${trade.stopLoss} | TP=${trade.takeProfit} | Size=${trade.size}`,
        {
          strategy: trade.strategyId,
          flow: trade.flow.flow,
          bias: trade.flow.macroBias,
        }
      );
    } else {
      const pnlStr =
        trade.pnlRaw !== null
          ? `PnL=${trade.pnlRaw.toFixed(4)} (${(trade.pnlR ?? 0).toFixed(2)}R)`
          : "PnL=?";
      const durationStr =
        trade.durationMs !== null
          ? `${Math.round(trade.durationMs / 60000)}m`
          : "?";

      winstonLogger.info(
        `[Trade ${trade.outcome.padEnd(8)}] ${trade.id.slice(0, 8)} | ${pnlStr} | exit @ ${trade.exitPrice} | duration=${durationStr}`,
        {
          strategy: trade.strategyId,
          flow: trade.flow.flow,
        }
      );
    }
  }

  // ── Session summary ───────────────────────────────────────

  /**
   * Prints and logs a summary of the session's closed trades.
   */
  logSessionSummary(
    closedTrades: Trade[],
    sessionStart: number,
    sessionEnd: number
  ): void {
    const wins = closedTrades.filter((t) => t.outcome === "WIN").length;
    const losses = closedTrades.filter((t) => t.outcome === "LOSS").length;
    const be = closedTrades.filter((t) => t.outcome === "BREAKEVEN").length;
    const totalR = closedTrades.reduce((s, t) => s + (t.pnlR ?? 0), 0);
    const totalPnl = closedTrades.reduce((s, t) => s + (t.pnlRaw ?? 0), 0);
    const winRate =
      wins + losses > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : "N/A";

    const summary = {
      sessionStart: new Date(sessionStart).toISOString(),
      sessionEnd: new Date(sessionEnd).toISOString(),
      totalTrades: closedTrades.length,
      wins,
      losses,
      breakeven: be,
      winRatePct: winRate,
      totalR: parseFloat(totalR.toFixed(3)),
      totalPnl: parseFloat(totalPnl.toFixed(4)),
      byStrategy: buildStrategyBreakdown(closedTrades),
    };

    appendRecord(path.join(LOG_DIR, "session-summaries.ndjson"), {
      ...summary,
      _loggedAt: new Date().toISOString(),
    });

    winstonLogger.info("═══ SESSION SUMMARY ═══", summary);
  }
}

// ── Strategy breakdown helper ──────────────────────────────

function buildStrategyBreakdown(
  trades: Trade[]
): Record<string, { trades: number; wins: number; totalR: number }> {
  const breakdown: Record<
    string,
    { trades: number; wins: number; totalR: number }
  > = {};

  for (const t of trades) {
    if (!breakdown[t.strategyId]) {
      breakdown[t.strategyId] = { trades: 0, wins: 0, totalR: 0 };
    }
    breakdown[t.strategyId].trades++;
    if (t.outcome === "WIN") breakdown[t.strategyId].wins++;
    breakdown[t.strategyId].totalR += t.pnlR ?? 0;
  }

  // Round R values
  for (const key of Object.keys(breakdown)) {
    breakdown[key].totalR = parseFloat(breakdown[key].totalR.toFixed(3));
  }

  return breakdown;
}
