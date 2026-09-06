// ============================================================
// Execution Engine
//
// Responsibilities:
//   1. Candle-close validation — only acts on fully closed M5 bars
//   2. Per-candle execution lock — prevents duplicate orders in the
//      same 5-minute block
//   3. Position sizing — risk-pct of account balance / ATR-based stop
//   4. Order placement — paper (simulated) or live via CCXT
//   5. Open trade tracking — monitors SL/TP and marks outcomes
//   6. maxOpenTrades guard
// ============================================================

import ccxt, { Exchange } from "ccxt";
import { v4 as uuidv4 } from "uuid";
import {
  Signal,
  SignalDirection,
  Order,
  OrderStatus,
  Trade,
  TradeOutcome,
  BotConfig,
  Candle,
} from "../types";

// ── Internal state ─────────────────────────────────────────
interface ExecutionState {
  /** Candle timestamp of the last block where an order was attempted */
  lastOrderCandleTs: number;
  /** All currently open trades */
  openTrades: Map<string, Trade>;
  /** All closed trades this session */
  closedTrades: Trade[];
}

export class ExecutionEngine {
  private exchange: Exchange;
  private config: BotConfig;
  private state: ExecutionState;

  /** Callback fired whenever a trade is opened or closed — used by the logger */
  public onTradeUpdate: ((trade: Trade) => void) | null = null;

  constructor(exchange: Exchange, config: BotConfig) {
    this.exchange = exchange;
    this.config = config;
    this.state = {
      lastOrderCandleTs: 0,
      openTrades: new Map(),
      closedTrades: [],
    };
  }

  // ──────────────────────────────────────────────────────────
  // Public: attempt to execute a signal
  // ──────────────────────────────────────────────────────────

  /**
   * Entry point called by the main loop after the classifier fires a signal.
   *
   * @param signal      - The signal from the flow classifier
   * @param triggerTs   - Timestamp of the M5 candle that triggered the signal
   * @returns The created Trade object, or null if blocked
   */
  async execute(signal: Signal, triggerTs: number): Promise<Trade | null> {
    // ── 1. Execution lock — one order per 5-minute block ──
    if (triggerTs <= this.state.lastOrderCandleTs) {
      console.warn(
        `[Engine] Execution blocked — already acted on candle block ${new Date(triggerTs).toISOString()}`
      );
      return null;
    }

    // ── 2. Max open trades guard ───────────────────────────
    if (this.state.openTrades.size >= this.config.maxOpenTrades) {
      console.warn(
        `[Engine] Max open trades (${this.config.maxOpenTrades}) reached — skipping signal`
      );
      return null;
    }

    // ── 3. Fetch current balance ───────────────────────────
    const balance = await this.fetchBalance();
    if (balance <= 0) {
      console.error("[Engine] Unable to fetch valid balance");
      return null;
    }

    // ── 4. Position sizing ────────────────────────────────
    // Risk amount = balance × riskPerTradePct
    // Stop distance = |entry - stopLoss|
    // Size = riskAmount / stopDistance  (in base currency units)
    const riskAmount = balance * this.config.riskPerTradePct;
    const stopDistance = Math.abs(signal.entryPrice - signal.stopLoss);

    if (stopDistance === 0) {
      console.error("[Engine] Stop distance is zero — cannot size position");
      return null;
    }

    const rawSize = riskAmount / stopDistance;
    const size = parseFloat(rawSize.toFixed(8)); // normalize precision

    if (size <= 0) {
      console.error(`[Engine] Calculated size ${size} is invalid`);
      return null;
    }

    // ── 5. Place order (paper or live) ────────────────────
    const order = this.config.paperTrading
      ? this.paperOrder(signal, size)
      : await this.liveOrder(signal, size);

    if (!order) return null;

    // ── 6. Lock this candle block ──────────────────────────
    this.state.lastOrderCandleTs = triggerTs;

    // ── 7. Build Trade record ─────────────────────────────
    const trade: Trade = {
      id: uuidv4(),
      signalId: signal.id,
      order,
      symbol: signal.symbol,
      strategyId: signal.strategyId,
      flow: signal.flow,
      direction: signal.direction,
      entryPrice: signal.entryPrice,
      exitPrice: null,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      size,
      pnlRaw: null,
      pnlR: null,
      outcome: TradeOutcome.OPEN,
      openedAt: Date.now(),
      closedAt: null,
      durationMs: null,
      indicators: signal.indicators,
      notes: `Strategy: ${signal.strategyId} | Flow: ${signal.flow.flow} | Score: ${
        signal.allScores.find((s) => s.strategyId === signal.strategyId)?.score ?? "?"
      }`,
    };

    this.state.openTrades.set(trade.id, trade);
    this.onTradeUpdate?.(trade);

    console.log(
      `[Engine] Trade OPENED | ${trade.id.slice(0, 8)} | ${trade.direction} ${trade.symbol} @ ${trade.entryPrice} | SL=${trade.stopLoss} | TP=${trade.takeProfit} | Size=${trade.size}`
    );

    return trade;
  }

  // ──────────────────────────────────────────────────────────
  // Public: check open trades against latest price
  // Called every candle close from the main loop
  // ──────────────────────────────────────────────────────────

  checkOpenTrades(latestCandle: Candle): void {
    for (const [id, trade] of this.state.openTrades) {
      const { high, low, close } = latestCandle;

      let outcome: TradeOutcome | null = null;
      let exitPrice: number | null = null;

      if (trade.direction === SignalDirection.LONG) {
        if (low <= trade.stopLoss) {
          outcome = TradeOutcome.LOSS;
          exitPrice = trade.stopLoss;
        } else if (high >= trade.takeProfit) {
          outcome = TradeOutcome.WIN;
          exitPrice = trade.takeProfit;
        }
      } else {
        if (high >= trade.stopLoss) {
          outcome = TradeOutcome.LOSS;
          exitPrice = trade.stopLoss;
        } else if (low <= trade.takeProfit) {
          outcome = TradeOutcome.WIN;
          exitPrice = trade.takeProfit;
        }
      }

      if (outcome !== null && exitPrice !== null) {
        this.closeTrade(trade, exitPrice, outcome, latestCandle.timestamp);
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  // Public: force-close all open trades (end of session)
  // ──────────────────────────────────────────────────────────

  closeAllAtMarket(currentPrice: number, reason: string = "Session end"): void {
    for (const [, trade] of this.state.openTrades) {
      const pnl =
        trade.direction === SignalDirection.LONG
          ? currentPrice - trade.entryPrice
          : trade.entryPrice - currentPrice;

      const outcome =
        pnl > 0
          ? TradeOutcome.WIN
          : pnl < 0
          ? TradeOutcome.LOSS
          : TradeOutcome.BREAKEVEN;

      this.closeTrade(trade, currentPrice, outcome, Date.now(), reason);
    }
  }

  // ──────────────────────────────────────────────────────────
  // Getters
  // ──────────────────────────────────────────────────────────

  getOpenTrades(): Trade[] {
    return Array.from(this.state.openTrades.values());
  }

  getClosedTrades(): Trade[] {
    return this.state.closedTrades;
  }

  getOpenTradeCount(): number {
    return this.state.openTrades.size;
  }

  // ──────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────

  private closeTrade(
    trade: Trade,
    exitPrice: number,
    outcome: TradeOutcome,
    closedAt: number,
    notes?: string
  ): void {
    const stopDistance = Math.abs(trade.entryPrice - trade.stopLoss);
    const pnlRaw =
      trade.direction === SignalDirection.LONG
        ? (exitPrice - trade.entryPrice) * trade.size
        : (trade.entryPrice - exitPrice) * trade.size;

    const pnlR = stopDistance > 0 ? pnlRaw / (stopDistance * trade.size) : 0;

    const closed: Trade = {
      ...trade,
      exitPrice,
      pnlRaw: parseFloat(pnlRaw.toFixed(8)),
      pnlR: parseFloat(pnlR.toFixed(3)),
      outcome,
      closedAt,
      durationMs: closedAt - trade.openedAt,
      notes: notes ? `${trade.notes} | ${notes}` : trade.notes,
    };

    this.state.openTrades.delete(trade.id);
    this.state.closedTrades.push(closed);
    this.onTradeUpdate?.(closed);

    console.log(
      `[Engine] Trade CLOSED | ${closed.id.slice(0, 8)} | ${outcome} | PnL=${pnlRaw.toFixed(4)} (${pnlR.toFixed(2)}R) | Exit @ ${exitPrice}`
    );
  }

  /** Simulate an immediate fill at signal entry price (paper trading) */
  private paperOrder(signal: Signal, size: number): Order {
    const now = Date.now();
    return {
      id: uuidv4(),
      exchangeOrderId: `PAPER-${uuidv4().slice(0, 8)}`,
      symbol: signal.symbol,
      direction: signal.direction,
      size,
      entryPrice: signal.entryPrice,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      status: OrderStatus.FILLED,
      placedAt: now,
      filledAt: now,
      closedAt: null,
    };
  }

  /** Place a real market order + SL/TP orders via CCXT */
  private async liveOrder(signal: Signal, size: number): Promise<Order | null> {
    const side = signal.direction === SignalDirection.LONG ? "buy" : "sell";
    const now = Date.now();

    const order: Order = {
      id: uuidv4(),
      exchangeOrderId: null,
      symbol: signal.symbol,
      direction: signal.direction,
      size,
      entryPrice: signal.entryPrice,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      status: OrderStatus.PENDING,
      placedAt: now,
      filledAt: null,
      closedAt: null,
    };

    try {
      // ── Entry market order ────────────────────────────
      const entryResp = await this.exchange.createOrder(
        signal.symbol,
        "market",
        side,
        size
      );
      order.exchangeOrderId = entryResp.id;
      order.status = OrderStatus.OPEN;
      order.filledAt = Date.now();

      // ── Stop-loss order ───────────────────────────────
      const slSide = side === "buy" ? "sell" : "buy";
      await this.exchange.createOrder(
        signal.symbol,
        "stop_market" as any,
        slSide,
        size,
        signal.stopLoss,
        { stopPrice: signal.stopLoss, reduceOnly: true }
      );

      // ── Take-profit order ─────────────────────────────
      await this.exchange.createOrder(
        signal.symbol,
        "take_profit_market" as any,
        slSide,
        size,
        signal.takeProfit,
        { stopPrice: signal.takeProfit, reduceOnly: true }
      );

      order.status = OrderStatus.FILLED;
      console.log(
        `[Engine] Live orders placed | Entry=${entryResp.id} | SL=${signal.stopLoss} | TP=${signal.takeProfit}`
      );
    } catch (err) {
      console.error("[Engine] Order placement failed:", err);
      order.status = OrderStatus.REJECTED;
      return null;
    }

    return order;
  }

  /** Fetch available balance in quote currency */
  private async fetchBalance(): Promise<number> {
    if (this.config.paperTrading) {
      // Return a fixed paper balance for sizing calculations
      return 10_000;
    }

    try {
      const balances = await this.exchange.fetchBalance();
      const quote = this.config.symbol.split("/")[1] ?? "USDT";
      const free = balances?.free as unknown as Record<string, number | undefined> | undefined;
      return free?.[quote] ?? 0;
    } catch (err) {
      console.error("[Engine] fetchBalance failed:", err);
      return 0;
    }
  }
}
