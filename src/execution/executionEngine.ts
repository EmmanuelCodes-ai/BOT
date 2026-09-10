// ============================================================
// Execution Engine
//
// Responsibilities:
//   1. Candle-close validation — only acts on fully closed M5 bars
//   2. Per-candle execution lock — prevents duplicate orders in the
//      same 5-minute block
//   3. Order sanity validation — strict directional checks before sizing
//   4. Position sizing — risk-pct of account balance / ATR-based stop
//   5. CCXT precision normalization — tick/lot size compliance
//   6. Order placement — paper (simulated) or live via CCXT
//   7. Open trade tracking — monitors SL/TP and marks outcomes
//   8. maxOpenTrades guard
// ============================================================

import { Exchange } from "ccxt";
import { v4 as uuidv4 } from "uuid";
import {
  Signal,
  SignalDirection,
  StrategyId,
  Order,
  OrderStatus,
  Trade,
  TradeOutcome,
  BotConfig,
  Candle,
  LiveBybitPosition,
} from "../types";
import { BotLogger } from "../logger";
import { TradeLedger } from "./ledger";

// ── Internal state ─────────────────────────────────────────
interface ExecutionState {
  lastOrderCandleTs: number;
  openTrades: Map<string, Trade>;
  closedTrades: Trade[];
  dayStartBalance: number;   // balance snapshotted at first fetch of the day
  dayStartDate: string;      // YYYY-MM-DD in WAT to detect day rollover
}

// ── Sanity check result ─────────────────────────────────────
interface SanityCheckResult {
  valid: boolean;
  reason: string;
}

export class ExecutionEngine {
  private exchange: Exchange;
  private config: BotConfig;
  private state: ExecutionState;
  private logger: BotLogger;
  private ledger: TradeLedger;
  private latestBalanceInfo: { equity: number; walletBalance: number; availableBalance: number } = {
    equity: 0,
    walletBalance: 0,
    availableBalance: 0,
  };

  public onTradeUpdate: ((trade: Trade) => void) | null = null;
  public onPartialProfit: ((trade: Trade, bankedRaw: number, profitPct: number, breakevenPrice: number) => void) | null = null;
  /**
   * Fires whenever a valid strategy signal is blocked by the
   * pre-entry market-regime filter. Used to emit Telegram telemetry.
   */
  public onFilterBlocked: ((
    signal: Signal,
    reason: string,
    appliedThresholds: { minVol: number; minBW: number; minATR: number },
    isStrategyAware: boolean
  ) => void) | null = null;

  constructor(exchange: Exchange, config: BotConfig, logger: BotLogger) {
    this.exchange = exchange;
    this.config = config;
    this.logger = logger;
    this.ledger = new TradeLedger();
    this.state = {
      lastOrderCandleTs: 0,
      openTrades: new Map(),
      closedTrades: [],
      dayStartBalance: 0,
      dayStartDate: "",
    };
  }

  // ──────────────────────────────────────────────────────────
  // Public: attempt to execute a signal
  // ──────────────────────────────────────────────────────────

  async execute(signal: Signal, triggerTs: number): Promise<Trade | null> {
    // ── 1. Execution lock ──────────────────────────────────
    if (triggerTs <= this.state.lastOrderCandleTs) {
      this.logger.warn("[Engine] Execution blocked — already acted on candle block", {
        candleTs: new Date(triggerTs).toISOString(),
      });
      return null;
    }

    // ── 2. Max open trades guard (Bybit API as Absolute Source of Truth) ─
    if (this.config.paperTrading) {
      if (this.state.openTrades.size >= this.config.maxOpenTrades) {
        this.logger.warn("[Engine] Max open trades reached (Paper) — skipping signal", {
          max: this.config.maxOpenTrades,
          current: this.state.openTrades.size,
        });
        return null;
      }
    } else {
      // First, sync any recent exchange-side closures directly from Bybit
      await this.syncWithLivePositions();

      const livePositions = await this.fetchLivePositions(signal.symbol);
      if (livePositions.length >= this.config.maxOpenTrades) {
        this.logger.warn("[Engine] Execution blocked: Bybit has active position(s)", {
          maxAllowed: this.config.maxOpenTrades,
          liveCount: livePositions.length,
          positions: livePositions.map(
            (p) => `${p.side.toUpperCase()} ${p.size} @ ${p.entryPrice} (uPnL: ${p.unrealizedPnl})`
          ),
        });
        return null;
      }

      // Check if there is already an active position for this exact symbol on Bybit
      const baseSymbol = signal.symbol.split("/")[0];
      const existingPos = livePositions.find(
        (p) => p.symbol === signal.symbol || p.symbol.includes(baseSymbol)
      );
      if (existingPos) {
        this.logger.warn("[Engine] Execution blocked: Bybit position already open for symbol", {
          symbol: signal.symbol,
          existingSide: existingPos.side,
          existingSize: existingPos.size,
          signalDirection: signal.direction,
        });
        return null;
      }
    }

    // ── 3. Order sanity validation ─────────────────────────
    const sanity = this.validateSignal(signal);
    if (!sanity.valid) {
      this.logger.error("[Engine] Signal failed sanity check — aborting", {
        reason: sanity.reason,
        direction: signal.direction,
        entry: signal.entryPrice,
        sl: signal.stopLoss,
        tp: signal.takeProfit,
      });
      return null;
    }

    // ── 3.5 Pre-entry market-regime filter ────────────────
    // Blocks execution during low-volatility / low-volume conditions.
    // Uses strategy-aware thresholds so mean-reversion setups are
    // not over-filtered during genuine overextension events.
    const regimeCheck = this.validatePreEntryMarketRegime(signal);
    if (!regimeCheck.passed) {
      this.logger.warn("[Engine] Signal blocked by pre-entry regime filter", {
        strategy: signal.strategyId,
        direction: signal.direction,
        reason: regimeCheck.reason,
        bbBandwidth: signal.indicators.bollinger.bandwidth.toFixed(5),
        atrExpansionRatio: signal.indicators.atrExpansionRatio.toFixed(3),
        volumeMultiplier: signal.indicators.volumeMultiplier.toFixed(2),
        strategyAware: regimeCheck.isStrategyAware,
        appliedThresholds: regimeCheck.appliedThresholds,
      });
      // Fire telemetry callback → Telegram diagnostic notification
      this.onFilterBlocked?.(
        signal,
        regimeCheck.reason!,
        regimeCheck.appliedThresholds!,
        regimeCheck.isStrategyAware
      );
      return null;
    }

    // ── 4. Fetch current balance ───────────────────────────
    const balance = await this.fetchBalance();
    if (balance <= 0) {
      this.logger.error("[Engine] Unable to fetch valid balance");
      return null;
    }

    // ── 5. Position sizing ─────────────────────────────────
    const stopDistance = Math.abs(signal.entryPrice - signal.stopLoss);
    const riskAmount = balance * this.config.riskPerTradePct;
    const rawSize = riskAmount / stopDistance;

    if (rawSize <= 0 || !isFinite(rawSize)) {
      this.logger.error("[Engine] Calculated size is invalid", {
        rawSize,
        riskAmount,
        stopDistance,
      });
      return null;
    }

    // ── 6. CCXT precision normalization ────────────────────
    const { entry, sl, tp, size } = this.normalizePrecision(
      signal.symbol,
      signal.entryPrice,
      signal.stopLoss,
      signal.takeProfit,
      rawSize
    );

    // ── 7. Place order (paper or live) ────────────────────
    const order = this.config.paperTrading
      ? this.paperOrder(signal, entry, sl, tp, size)
      : await this.liveOrder(signal, entry, sl, tp, size);

    if (!order) return null;

    // ── 8. Lock this candle block ──────────────────────────
    this.state.lastOrderCandleTs = triggerTs;

    // ── 9. Build Trade record ─────────────────────────────
    const trade: Trade = {
      id: uuidv4(),
      signalId: signal.id,
      order,
      symbol: signal.symbol,
      strategyId: signal.strategyId,
      flow: signal.flow,
      direction: signal.direction,
      entryPrice: order.entryPrice,
      exitPrice: null,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      size: order.size,
      originalSize: order.size,
      originalStopLoss: order.stopLoss,
      partialTaken: false,
      isBreakeven: false,
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
    this.ledger.recordOpen(trade, order.entryPrice);
    this.onTradeUpdate?.(trade);

    this.logger.info("[Engine] Trade OPENED", {
      id: trade.id.slice(0, 8),
      direction: trade.direction,
      symbol: trade.symbol,
      entry,
      sl,
      tp,
      size,
    });

    return trade;
  }

  // ──────────────────────────────────────────────────────────
  // Public: high-frequency live price progress monitor
  // Evaluates partial profit taking & breakeven shifts every tick
  // ──────────────────────────────────────────────────────────

  async checkTradeProgress(currentPrice: number): Promise<void> {
    if (this.state.openTrades.size === 0 || currentPrice <= 0) return;
    this.ledger.updateMarkPrice(currentPrice);

    for (const [, trade] of this.state.openTrades) {
      if (trade.entryPrice <= 0) continue;

      const rawPriceChangePct = trade.direction === SignalDirection.LONG
        ? ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100
        : ((trade.entryPrice - currentPrice) / trade.entryPrice) * 100;

      const leverage = (this.config.leverage && this.config.leverage > 0) ? this.config.leverage : 10;
      const currentROI = rawPriceChangePct * leverage; // Bybit Position ROI %

      // 1. Check aggressive early partial profit harvest (+0.5% Bybit Position ROI default)
      const targetROI = this.config.partialProfitROIPct ?? 0.5;
      if (this.config.enableEarlyPartials && !trade.partialTaken && currentROI >= targetROI) {
        await this.harvestPartial(trade, currentPrice, currentROI, rawPriceChangePct);
      }

      // 2. Check full Stop Loss or Take Profit exit against live price
      if (trade.direction === SignalDirection.LONG) {
        if (currentPrice <= trade.stopLoss) {
          this.closeTrade(
            trade,
            trade.stopLoss,
            trade.isBreakeven ? TradeOutcome.BREAKEVEN : TradeOutcome.LOSS,
            Date.now(),
            trade.isBreakeven ? "Stopped out at Breakeven" : "Hit Stop Loss"
          );
        } else if (currentPrice >= trade.takeProfit) {
          this.closeTrade(trade, trade.takeProfit, TradeOutcome.WIN, Date.now(), "Hit Take Profit");
        }
      } else {
        if (currentPrice >= trade.stopLoss) {
          this.closeTrade(
            trade,
            trade.stopLoss,
            trade.isBreakeven ? TradeOutcome.BREAKEVEN : TradeOutcome.LOSS,
            Date.now(),
            trade.isBreakeven ? "Stopped out at Breakeven" : "Hit Stop Loss"
          );
        } else if (currentPrice <= trade.takeProfit) {
          this.closeTrade(trade, trade.takeProfit, TradeOutcome.WIN, Date.now(), "Hit Take Profit");
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  // Public: check open trades against latest candle
  // ──────────────────────────────────────────────────────────

  async checkOpenTrades(latestCandle: Candle): Promise<void> {
    this.ledger.updateMarkPrice(latestCandle.close);

    for (const [, trade] of this.state.openTrades) {
      const { high, low } = latestCandle;
      if (trade.entryPrice <= 0) continue;

      // 1. Check early partial take-profit breached by candle high/low (+0.5% Bybit Position ROI)
      if (this.config.enableEarlyPartials && !trade.partialTaken) {
        const leverage = (this.config.leverage && this.config.leverage > 0) ? this.config.leverage : 10;
        const targetROI = this.config.partialProfitROIPct ?? 0.5;
        const targetPricePct = targetROI / leverage; // in percent e.g. 0.5 / 10 = 0.05%
        const targetGainFraction = targetPricePct / 100; // in fraction e.g. 0.0005

        const isPartialHit =
          trade.direction === SignalDirection.LONG
            ? (high - trade.entryPrice) / trade.entryPrice >= targetGainFraction
            : (trade.entryPrice - low) / trade.entryPrice >= targetGainFraction;

        if (isPartialHit) {
          const harvestPrice =
            trade.direction === SignalDirection.LONG
              ? trade.entryPrice * (1 + targetGainFraction)
              : trade.entryPrice * (1 - targetGainFraction);
          await this.harvestPartial(trade, harvestPrice, targetROI, targetPricePct);
        }
      }

      // 2. Check remaining position SL / TP
      let outcome: TradeOutcome | null = null;
      let exitPrice: number | null = null;

      if (trade.direction === SignalDirection.LONG) {
        if (low <= trade.stopLoss) {
          outcome = trade.isBreakeven ? TradeOutcome.BREAKEVEN : TradeOutcome.LOSS;
          exitPrice = trade.stopLoss;
        } else if (high >= trade.takeProfit) {
          outcome = TradeOutcome.WIN;
          exitPrice = trade.takeProfit;
        }
      } else {
        if (high <= trade.stopLoss) {
          outcome = trade.isBreakeven ? TradeOutcome.BREAKEVEN : TradeOutcome.LOSS;
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
  // Private: harvest early partial profit & move SL to breakeven
  // ──────────────────────────────────────────────────────────

  async harvestPartial(trade: Trade, currentPrice: number, currentROI: number, rawPricePct: number): Promise<void> {
    try {
      const closePct = this.config.partialClosePct ?? 0.5;
      const rawCloseSize = trade.size * closePct;
      let closeSize = rawCloseSize;

      if (this.exchange.markets?.[trade.symbol]) {
        closeSize = parseFloat(this.exchange.amountToPrecision(trade.symbol, rawCloseSize));
      }
      if (closeSize <= 0 || closeSize >= trade.size) {
        closeSize = parseFloat((trade.size * 0.5).toFixed(8));
      }

      const roiFormatted = `+${currentROI.toFixed(2)}% ROI`;
      const pricePctFormatted = `+${rawPricePct.toFixed(3)}%`;

      // If live trading on Bybit, place reduce-only market order
      const hasApiKey = Boolean(this.exchange.apiKey && this.exchange.apiKey.trim().length > 5);
      if (hasApiKey && !this.config.paperTrading) {
        const side = trade.direction === SignalDirection.LONG ? "sell" : "buy";
        try {
          this.logger.info("[Engine] Executing early partial close on Bybit", {
            symbol: trade.symbol,
            side,
            size: closeSize,
            triggerROI: roiFormatted,
          });
          const resp = await this.exchange.createOrder(
            trade.symbol,
            "market",
            side,
            closeSize,
            undefined,
            { reduceOnly: true }
          );
          this.logger.info("[Engine] Bybit early partial filled", { orderId: resp.id, closeSize });
        } catch (orderErr) {
          this.logger.error("[Engine] Bybit early partial close failed", { error: String(orderErr) });
        }
      }

      // Banked PnL calculations
      const bankedRaw =
        trade.direction === SignalDirection.LONG
          ? (currentPrice - trade.entryPrice) * closeSize
          : (trade.entryPrice - currentPrice) * closeSize;

      const stopDistance = Math.abs(trade.entryPrice - (trade.originalStopLoss ?? trade.stopLoss));
      const bankedR = stopDistance > 0 ? bankedRaw / (stopDistance * closeSize) : 0;

      // Calculate breakeven price with fee buffer (e.g. 0.05% of entry price to cover exchange taker/maker fee)
      const bufferRate = this.config.breakevenBufferPct ?? 0.0005;
      const feeBuffer = trade.entryPrice * bufferRate;
      let bePrice =
        trade.direction === SignalDirection.LONG
          ? trade.entryPrice + feeBuffer
          : trade.entryPrice - feeBuffer;
      if (this.exchange.markets?.[trade.symbol]) {
        bePrice = parseFloat(this.exchange.priceToPrecision(trade.symbol, bePrice));
      }

      // Update position stop loss on Bybit
      if (hasApiKey && !this.config.paperTrading) {
        try {
          const marketId = (this.exchange.market(trade.symbol)?.id ?? trade.symbol.replace("/", "").split(":")[0]).replace(/[^a-zA-Z0-9]/g, "");
          if (typeof (this.exchange as any).privatePostV5PositionTradingStop === "function") {
            await (this.exchange as any).privatePostV5PositionTradingStop({
              category: "linear",
              symbol: marketId,
              stopLoss: bePrice.toString(),
              slTriggerBy: "LastPrice",
              tpslMode: "Full",
              positionIdx: 0,
            });
            this.logger.info("[Engine] Shifted Stop Loss to Breakeven on Bybit position", {
              symbol: marketId,
              bePrice,
            });
          }
        } catch (stopErr) {
          this.logger.warn("[Engine] Could not shift position stop loss on Bybit via privatePostV5PositionTradingStop", {
            error: String(stopErr),
          });
        }
      }

      // Update trade state
      trade.partialTaken = true;
      trade.partialExitPrice = currentPrice;
      trade.partialSize = closeSize;
      trade.partialPnlRaw = parseFloat(bankedRaw.toFixed(4));
      trade.partialPnlR = parseFloat(bankedR.toFixed(3));
      trade.partialPnlPct = parseFloat(currentROI.toFixed(2));
      trade.size = parseFloat((trade.size - closeSize).toFixed(8));
      trade.stopLoss = bePrice;
      trade.order.stopLoss = bePrice;
      trade.isBreakeven = true;

      // Record in ledger
      this.ledger.recordPartialClose(trade, closeSize, currentPrice, bankedRaw, bankedR, bePrice, parseFloat(currentROI.toFixed(2)));

      this.logger.info("🎯 [Engine] EARLY PARTIAL HARVESTED & SL SHIFTED TO BREAKEVEN", {
        id: trade.id.slice(0, 8),
        symbol: trade.symbol,
        roi: roiFormatted,
        pricePct: pricePctFormatted,
        bankedUSD: bankedRaw.toFixed(4),
        newStopLoss: bePrice,
        remainingSize: trade.size,
      });

      console.log("\n═════════════════════════════════════════════════════");
      console.log(`       🎯 EARLY PARTIAL PROFIT HARVESTED (${roiFormatted})      `);
      console.log("═════════════════════════════════════════════════════");
      console.log(`Symbol       : ${trade.symbol}`);
      console.log(`Harvest Price: ${currentPrice} (${roiFormatted} | ${pricePctFormatted} Price Move)`);
      console.log(`Banked PnL   : +$${bankedRaw.toFixed(2)} (${roiFormatted})`);
      console.log(`Remaining Pos: ${trade.size}`);
      console.log(`New Stop Loss: ${bePrice} (Breakeven + Fee Buffer)`);
      console.log("Trade State  : 100% RISK-FREE 🛡️");
      console.log("═════════════════════════════════════════════════════\n");

      this.onPartialProfit?.(trade, bankedRaw, currentROI, bePrice);
    } catch (err) {
      this.logger.error("[Engine] Error in harvestPartial", { error: String(err) });
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
  // Bybit V5 Live Position Integration (Absolute Source of Truth)
  // ──────────────────────────────────────────────────────────

  /**
   * Fetches active positions directly from Bybit's API as the absolute source of truth.
   * In live mode, queries exchange positions where size / contracts > 0.
   */
  async fetchLivePositions(symbol?: string): Promise<LiveBybitPosition[]> {
    if (this.config.paperTrading) {
      return Array.from(this.state.openTrades.values()).map((t) => ({
        symbol: t.symbol,
        side: t.direction === SignalDirection.LONG ? "long" : "short",
        size: t.size,
        entryPrice: t.entryPrice,
        unrealizedPnl: t.pnlRaw ?? 0,
        leverage: this.config.leverage ?? 10,
        stopLoss: t.stopLoss,
        takeProfit: t.takeProfit,
        markPrice: t.entryPrice,
      }));
    }

    try {
      const targetSymbol = symbol ?? this.config.symbol;
      let rawPositions: any[] = [];

      try {
        rawPositions = await this.exchange.fetchPositions([targetSymbol]);
      } catch (ccxtErr) {
        // Fallback: direct Bybit V5 privateGetV5PositionList
        if (typeof (this.exchange as any).privateGetV5PositionList === "function") {
          const marketId = (this.exchange.market(targetSymbol)?.id ?? targetSymbol.replace("/", "").split(":")[0]).replace(/[^a-zA-Z0-9]/g, "");
          const resp = await (this.exchange as any).privateGetV5PositionList({
            category: "linear",
            symbol: marketId,
          });
          rawPositions = (resp?.result?.list ?? []).map((item: any) => ({
            symbol: targetSymbol,
            side: item.side?.toLowerCase(),
            contracts: parseFloat(item.size || "0"),
            entryPrice: parseFloat(item.avgPrice || "0"),
            unrealizedPnl: parseFloat(item.unrealisedPnl || "0"),
            leverage: parseFloat(item.leverage || "1"),
            stopLoss: parseFloat(item.stopLoss || "0"),
            takeProfit: parseFloat(item.takeProfit || "0"),
            markPrice: parseFloat(item.markPrice || "0"),
            bustPrice: parseFloat(item.bustPrice || "0"),
            info: item,
          }));
        } else {
          throw ccxtErr;
        }
      }

      const activePositions: LiveBybitPosition[] = [];

      for (const pos of rawPositions) {
        const rawSize = pos.contracts ?? (pos.info as any)?.size;
        const contracts = Math.abs(parseFloat(String(rawSize ?? 0)));
        if (contracts > 0) {
          const rawSide = (pos.side ?? (pos.info as any)?.side ?? "").toLowerCase();
          const side: "long" | "short" = (rawSide === "buy" || rawSide === "long") ? "long" : "short";
          const entryPrice = pos.entryPrice ?? parseFloat((pos.info as any)?.avgPrice ?? "0");
          const unrealizedPnl = pos.unrealizedPnl ?? parseFloat((pos.info as any)?.unrealisedPnl ?? "0");
          const leverage = pos.leverage ?? parseFloat((pos.info as any)?.leverage ?? "1");
          const sl = pos.stopLoss ?? parseFloat((pos.info as any)?.stopLoss ?? "0");
          const tp = pos.takeProfit ?? parseFloat((pos.info as any)?.takeProfit ?? "0");
          const markPrice = pos.markPrice ?? parseFloat((pos.info as any)?.markPrice ?? "0");
          const bustPrice = parseFloat((pos.info as any)?.bustPrice ?? "0");

          activePositions.push({
            symbol: pos.symbol ?? targetSymbol,
            side,
            size: contracts,
            entryPrice,
            unrealizedPnl,
            leverage,
            stopLoss: sl > 0 ? sl : undefined,
            takeProfit: tp > 0 ? tp : undefined,
            markPrice: markPrice > 0 ? markPrice : undefined,
            bustPrice: bustPrice > 0 ? bustPrice : undefined,
            updatedTime: (pos.info as any)?.updatedTime ? parseInt((pos.info as any).updatedTime, 10) : undefined,
          });
        }
      }

      return activePositions;
    } catch (err) {
      this.logger.error("[Engine] fetchLivePositions failed", { error: String(err) });
      return [];
    }
  }

  /**
   * Reconciles internal in-memory trades and ledger with live positions from Bybit.
   * If Bybit shows 0 position or trade is no longer active on exchange, it marks
   * the trade closed in local memory & ledger, preventing ghost positions.
   */
  async syncWithLivePositions(currentPrice?: number): Promise<void> {
    if (this.config.paperTrading) return;

    try {
      const livePositions = await this.fetchLivePositions();

      for (const [tradeId, trade] of Array.from(this.state.openTrades.entries())) {
        const baseSymbol = trade.symbol.split("/")[0];
        const matchingPos = livePositions.find(
          (p) =>
            (p.symbol === trade.symbol || p.symbol.includes(baseSymbol)) &&
            p.side === (trade.direction === SignalDirection.LONG ? "long" : "short")
        );

        if (!matchingPos) {
          // Position is completely closed on Bybit!
          const exitPrice = currentPrice && currentPrice > 0 ? currentPrice : trade.entryPrice;
          const isLong = trade.direction === SignalDirection.LONG;
          const rawGain = isLong ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice;
          let outcome = rawGain > 0 ? TradeOutcome.WIN : (rawGain < 0 ? TradeOutcome.LOSS : TradeOutcome.BREAKEVEN);
          let note = "Closed on Bybit (Exchange-side TP/SL or manual exit)";

          if (currentPrice && currentPrice > 0) {
            if (trade.direction === SignalDirection.LONG) {
              if (trade.takeProfit && currentPrice >= trade.takeProfit) {
                outcome = TradeOutcome.WIN;
                note = "Bybit Take Profit executed";
              } else if (trade.stopLoss && currentPrice <= trade.stopLoss) {
                outcome = trade.isBreakeven ? TradeOutcome.BREAKEVEN : TradeOutcome.LOSS;
                note = trade.isBreakeven ? "Bybit Breakeven Stop executed" : "Bybit Stop Loss executed";
              }
            } else {
              if (trade.takeProfit && currentPrice <= trade.takeProfit) {
                outcome = TradeOutcome.WIN;
                note = "Bybit Take Profit executed";
              } else if (trade.stopLoss && currentPrice >= trade.stopLoss) {
                outcome = trade.isBreakeven ? TradeOutcome.BREAKEVEN : TradeOutcome.LOSS;
                note = trade.isBreakeven ? "Bybit Breakeven Stop executed" : "Bybit Stop Loss executed";
              }
            }
          }

          this.logger.info("[Engine] Live position closed on Bybit — reconciling local state", {
            tradeId: trade.id.slice(0, 8),
            symbol: trade.symbol,
            direction: trade.direction,
            outcome,
            note,
          });

          this.closeTrade(trade, exitPrice, outcome, Date.now(), note);
        } else {
          // Position still active on Bybit: sync size and stop loss if updated
          if (matchingPos.size > 0 && matchingPos.size < trade.size) {
            this.logger.info("[Engine] Live position size reduced on Bybit — updating internal size", {
              tradeId: trade.id.slice(0, 8),
              previousSize: trade.size,
              currentBybitSize: matchingPos.size,
            });
            trade.size = matchingPos.size;
          }
          if (matchingPos.stopLoss && matchingPos.stopLoss > 0 && matchingPos.stopLoss !== trade.stopLoss) {
            trade.stopLoss = matchingPos.stopLoss;
            trade.order.stopLoss = matchingPos.stopLoss;
          }
          if (matchingPos.takeProfit && matchingPos.takeProfit > 0 && matchingPos.takeProfit !== trade.takeProfit) {
            trade.takeProfit = matchingPos.takeProfit;
            trade.order.takeProfit = matchingPos.takeProfit;
          }
        }
      }
    } catch (err) {
      this.logger.error("[Engine] Error during syncWithLivePositions", { error: String(err) });
    }
  }


  // ──────────────────────────────────────────────────────────
  // Public: initialise balance snapshot on startup
  // Call this once after the exchange is ready
  // ──────────────────────────────────────────────────────────

  async initBalance(): Promise<void> {
    const balance = await this.fetchBalance();
    this.snapshotDayStart(balance);
    this.ledger.initCapital(balance);
    this.logger.info("[Engine] Opening balance initialised", { balance });
  }

  getLedger(): TradeLedger {
    return this.ledger;
  }

  getDayStartBalance(): number {
    return this.state.dayStartBalance;
  }

  /**
   * Async version — fetches real balance from exchange when not paper trading.
   * Use this for the daily summary to get accurate closing balance.
   */
  async getCurrentBalanceAsync(): Promise<number> {
    if (this.config.paperTrading) {
      return this.getCurrentBalance();
    }
    return await this.fetchBalance();
  }

  /**
   * Sync version — paper balance adjusted by closed trade PnL.
   * Used internally where async is not available.
   */
  getCurrentBalance(): number {
    const totalPnl = this.state.closedTrades.reduce(
      (s, t) => s + (t.pnlRaw ?? 0),
      0
    );
    const base = this.state.dayStartBalance > 0
      ? this.state.dayStartBalance
      : this.config.paperBalance;
    return parseFloat((base + totalPnl).toFixed(4));
  }

  // ──────────────────────────────────────────────────────────
  // Private: order sanity validation
  // ──────────────────────────────────────────────────────────

  private validateSignal(signal: Signal): SanityCheckResult {
    const { direction, entryPrice, stopLoss, takeProfit } = signal;
    const stopDistance = Math.abs(entryPrice - stopLoss);

    if (stopDistance === 0) {
      return { valid: false, reason: "Stop distance is zero" };
    }

    if (direction === SignalDirection.LONG) {
      if (stopLoss >= entryPrice) {
        return {
          valid: false,
          reason: `LONG signal invalid: stopLoss (${stopLoss}) must be < entryPrice (${entryPrice})`,
        };
      }
      if (takeProfit <= entryPrice) {
        return {
          valid: false,
          reason: `LONG signal invalid: takeProfit (${takeProfit}) must be > entryPrice (${entryPrice})`,
        };
      }
    } else {
      if (stopLoss <= entryPrice) {
        return {
          valid: false,
          reason: `SHORT signal invalid: stopLoss (${stopLoss}) must be > entryPrice (${entryPrice})`,
        };
      }
      if (takeProfit >= entryPrice) {
        return {
          valid: false,
          reason: `SHORT signal invalid: takeProfit (${takeProfit}) must be < entryPrice (${entryPrice})`,
        };
      }
    }

    return { valid: true, reason: "OK" };
  }

  // ──────────────────────────────────────────────────────────
  // Private: global pre-entry market-regime filter (strategy-aware)
  //
  // Applies three checks before any order dispatch:
  //   1. Volume Confirmation  — trigger candle >= X × 20-period avg
  //   2. Bollinger Bandwidth  — market actively expanding, not flat
  //   3. ATR Expansion Ratio  — current ATR vs its 50-candle average
  //
  // Strategy-aware sensitivity:
  //   TREND_PULLBACK_EMA, LIQUIDITY_SWEEP_REVERSAL
  //     → STRICT defaults (momentum required, both BB and volume)
  //   SR_FLIP_INVERSION
  //     → STANDARD defaults, mild volume relaxation (0.85×)
  //   BB_MEAN_REVERSION, VWAP_DEVIATION_REVERSAL
  //     → RELAXED volume (0.7×) and bandwidth (0.0015) ONLY when
  //       genuine overextension is confirmed (RSI ≥70/≤30 or
  //       VWAP deviation ≥0.5%). Otherwise uses standard defaults.
  //       ATR ratio is ALWAYS enforced (protects against dead markets).
  // ──────────────────────────────────────────────────────────

  private validatePreEntryMarketRegime(signal: Signal): {
    passed: boolean;
    reason?: string;
    isStrategyAware: boolean;
    appliedThresholds?: { minVol: number; minBW: number; minATR: number };
  } {
    // Master switch — bypasses all checks when disabled
    if (!this.config.enablePreEntryFilters) {
      return { passed: true, isStrategyAware: false };
    }

    const { bollinger, volumeMultiplier, atrExpansionRatio, rsi14, vwap } = signal.indicators;
    const baseVol = this.config.minVolumeMultiplier;
    const baseBW  = this.config.minBollingerBandwidth;
    const baseATR = this.config.minATRExpansionRatio;

    // ── Derive per-strategy threshold overrides ──────────────
    // Default: use strict base thresholds (trend/breakout strategies)
    let minVol = baseVol;
    let minBW  = baseBW;
    let minATR = baseATR;
    let isStrategyAware = false;

    const sid = signal.strategyId;

    if (
      sid === StrategyId.BB_MEAN_REVERSION ||
      sid === StrategyId.VWAP_DEVIATION_REVERSAL
    ) {
      // Mean-reversion strategies operate in overextension zones where
      // volume may be declining before the reversal candle forms.
      // Relax volume and bandwidth ONLY when extreme RSI or large
      // VWAP deviation confirms genuine overextension — not random chop.
      const isExtremeRSI = rsi14 >= 70 || rsi14 <= 30;
      const isExtremeVWAP = Math.abs(vwap.deviationPct) >= 0.5;

      if (isExtremeRSI || isExtremeVWAP) {
        minVol = 0.70;   // allow lower participation during exhaustion
        minBW  = 0.0015; // allow tighter bands (mean-reversion works here)
        // ATR ratio stays at base — dead market risk remains
        isStrategyAware = true;
      }
      // Without extreme RSI/VWAP confirmation, falls through to standard defaults

    } else if (sid === StrategyId.SR_FLIP_INVERSION) {
      // S/R flip retests happen at recently broken levels where volume
      // was already committed during the initial break. Mild relaxation.
      minVol = Math.max(0.85, baseVol * 0.85);
      isStrategyAware = true;
    }
    // TREND_PULLBACK_EMA and LIQUIDITY_SWEEP_REVERSAL use strict defaults

    const appliedThresholds = { minVol, minBW, minATR };

    // ── Check 1: Volume confirmation ──────────────────────────
    if (volumeMultiplier < minVol) {
      return {
        passed: false,
        isStrategyAware,
        appliedThresholds,
        reason: `Volume too low: ${volumeMultiplier.toFixed(2)}x vs required ${minVol.toFixed(2)}x (20-period avg)`,
      };
    }

    // ── Check 2: Bollinger Bandwidth ──────────────────────────
    // Bandwidth = (upper − lower) / middle. Extreme compression means
    // there is no directional energy to capture even for reversals.
    if (bollinger.bandwidth < minBW) {
      return {
        passed: false,
        isStrategyAware,
        appliedThresholds,
        reason: `Bollinger Bandwidth too compressed: ${bollinger.bandwidth.toFixed(5)} vs minimum ${minBW.toFixed(5)}`,
      };
    }

    // ── Check 3: ATR Expansion Ratio (dynamic baseline) ───────
    // Compares current ATR(14) against its 50-period SMA.
    // Applied to ALL strategies — even mean-reversion should not
    // fire in a dead/flat market with no range to capture.
    if (atrExpansionRatio < minATR) {
      return {
        passed: false,
        isStrategyAware,
        appliedThresholds,
        reason: `ATR contraction: expansion ratio ${atrExpansionRatio.toFixed(3)} below threshold ${minATR.toFixed(3)} (atr14/avgATR50)`,
      };
    }

    return { passed: true, isStrategyAware, appliedThresholds };
  }

  // ──────────────────────────────────────────────────────────
  // Private: CCXT precision normalization
  // ──────────────────────────────────────────────────────────

  /**
   * Normalizes all price and size values to the exchange's
   * tick size and lot size requirements using CCXT built-ins.
   * Falls back to raw values if the market is not found.
   */
  private normalizePrecision(
    symbol: string,
    entryPrice: number,
    stopLoss: number,
    takeProfit: number,
    size: number
  ): { entry: number; sl: number; tp: number; size: number } {
    try {
      const market = this.exchange.markets?.[symbol];
      if (!market) {
        this.logger.warn("[Engine] Market not found for precision normalization — using raw values", {
          symbol,
        });
        return { entry: entryPrice, sl: stopLoss, tp: takeProfit, size };
      }

      const entry = parseFloat(this.exchange.priceToPrecision(symbol, entryPrice));
      const sl = parseFloat(this.exchange.priceToPrecision(symbol, stopLoss));
      const tp = parseFloat(this.exchange.priceToPrecision(symbol, takeProfit));
      const normalizedSize = parseFloat(this.exchange.amountToPrecision(symbol, size));

      this.logger.debug("[Engine] Precision normalization applied", {
        raw: { entryPrice, stopLoss, takeProfit, size },
        normalized: { entry, sl, tp, size: normalizedSize },
      });

      return { entry, sl, tp, size: normalizedSize };
    } catch (err) {
      this.logger.warn("[Engine] Precision normalization failed — using raw values", {
        error: String(err),
      });
      return { entry: entryPrice, sl: stopLoss, tp: takeProfit, size };
    }
  }

  // ──────────────────────────────────────────────────────────
  // Private: trade closing
  // ──────────────────────────────────────────────────────────

  private closeTrade(
    trade: Trade,
    exitPrice: number,
    outcome: TradeOutcome,
    closedAt: number,
    notes?: string
  ): void {
    const originalStopDist = Math.abs(trade.entryPrice - (trade.originalStopLoss ?? trade.stopLoss));
    const remainingPnL =
      trade.direction === SignalDirection.LONG
        ? (exitPrice - trade.entryPrice) * trade.size
        : (trade.entryPrice - exitPrice) * trade.size;

    const totalPnlRaw = remainingPnL + (trade.partialPnlRaw ?? 0);
    const initialRiskUSD = originalStopDist * (trade.originalSize ?? trade.size);
    const totalPnlR = initialRiskUSD > 0 ? totalPnlRaw / initialRiskUSD : 0;

    // If trade took partial profits and stopped out at breakeven, count as WIN or BREAKEVEN
    let finalOutcome = outcome;
    if (trade.partialTaken && (outcome === TradeOutcome.LOSS || outcome === TradeOutcome.BREAKEVEN)) {
      finalOutcome = totalPnlRaw > 0 ? TradeOutcome.WIN : TradeOutcome.BREAKEVEN;
    }

    const closed: Trade = {
      ...trade,
      exitPrice,
      pnlRaw: parseFloat(totalPnlRaw.toFixed(8)),
      pnlR: parseFloat(totalPnlR.toFixed(3)),
      outcome: finalOutcome,
      closedAt,
      durationMs: closedAt - trade.openedAt,
      notes: trade.partialTaken
        ? `${trade.notes} | Partial: +$${trade.partialPnlRaw?.toFixed(2)} (+${(trade.partialPnlPct ?? (trade.partialPnlR ?? 0) * 100).toFixed(2)}%) | Runner: $${remainingPnL.toFixed(2)} | Total: $${totalPnlRaw.toFixed(2)}`
        : (notes ? `${trade.notes} | ${notes}` : trade.notes),
    };

    this.state.openTrades.delete(trade.id);
    this.state.closedTrades.push(closed);
    this.ledger.recordClose(closed);
    this.onTradeUpdate?.(closed);

    this.logger.info("[Engine] Trade CLOSED", {
      id: closed.id.slice(0, 8),
      outcome: finalOutcome,
      pnl: `${totalPnlRaw.toFixed(4)} (${totalPnlR.toFixed(2)}R)`,
      exit: exitPrice,
    });
  }

  // ──────────────────────────────────────────────────────────
  // Private: order methods
  // ──────────────────────────────────────────────────────────

  private paperOrder(
    signal: Signal,
    entry: number,
    sl: number,
    tp: number,
    size: number
  ): Order {
    const now = Date.now();
    return {
      id: uuidv4(),
      exchangeOrderId: `PAPER-${uuidv4().slice(0, 8)}`,
      symbol: signal.symbol,
      direction: signal.direction,
      size,
      entryPrice: entry,
      stopLoss: sl,
      takeProfit: tp,
      status: OrderStatus.FILLED,
      placedAt: now,
      filledAt: now,
      closedAt: null,
    };
  }

  private async liveOrder(
    signal: Signal,
    entry: number,
    sl: number,
    tp: number,
    size: number
  ): Promise<Order | null> {
    const side = signal.direction === SignalDirection.LONG ? "buy" : "sell";
    const slSide = side === "buy" ? "sell" : "buy";
    const now = Date.now();

    const order: Order = {
      id: uuidv4(),
      exchangeOrderId: null,
      symbol: signal.symbol,
      direction: signal.direction,
      size,
      entryPrice: entry,
      stopLoss: sl,
      takeProfit: tp,
      status: OrderStatus.PENDING,
      placedAt: now,
      filledAt: null,
      closedAt: null,
    };

    try {
      // ── Entry market order with SL/TP attached ────────
      // Bybit futures requires SL and TP to be set on the
      // entry order directly, not as separate orders.
      const entryResp = await this.exchange.createOrder(
        signal.symbol,
        "market",
        side,
        size,
        undefined,
        {
          stopLoss: sl,
          takeProfit: tp,
          slTriggerBy: "LastPrice",
          tpTriggerBy: "LastPrice",
        }
      );
      order.exchangeOrderId = entryResp.id;
      order.status = OrderStatus.FILLED;
      order.filledAt = Date.now();

      // Fetch real execution details directly from Bybit API
      let actualFillPrice = entryResp.average ?? entryResp.price ?? entry;
      let actualFilledSize = entryResp.filled ?? size;
      let actualStopLoss = (entryResp as any).stopLoss ?? sl;
      let actualTakeProfit = (entryResp as any).takeProfit ?? tp;

      try {
        await new Promise((r) => setTimeout(r, 250));
        const fetched: any = await this.exchange.fetchOrder(entryResp.id, signal.symbol);
        if (fetched) {
          const p = fetched.average ?? fetched.price;
          if (p && p > 0) actualFillPrice = p;
          if (fetched.filled && fetched.filled > 0) actualFilledSize = fetched.filled;
          const fetchedSl = parseFloat(fetched.stopLoss ?? fetched.info?.stopLoss);
          const fetchedTp = parseFloat(fetched.takeProfit ?? fetched.info?.takeProfit);
          if (fetchedSl && fetchedSl > 0) actualStopLoss = fetchedSl;
          if (fetchedTp && fetchedTp > 0) actualTakeProfit = fetchedTp;
        }
      } catch (fErr) {
        this.logger.warn("[Engine] Could not fetch filled order details from Bybit API", { error: String(fErr) });
      }

      order.entryPrice = actualFillPrice;
      order.size = actualFilledSize;
      order.stopLoss = actualStopLoss;
      order.takeProfit = actualTakeProfit;

      // Query Bybit for TP/SL IDs (Current Orders)
      try {
        const openOrders: any[] = await this.exchange.fetchOpenOrders(signal.symbol);
        for (const o of openOrders) {
          const id8 = (o.id ?? "").slice(-8);
          if (o.info?.stopOrderType === "TakeProfit" || (o.takeProfit && o.takeProfit > 0) || o.info?.orderType === "TakeProfit") {
            order.bybitTpId = id8;
          } else if (o.info?.stopOrderType === "StopLoss" || (o.stopLoss && o.stopLoss > 0) || o.info?.orderType === "StopLoss") {
            order.bybitSlId = id8;
          }
        }
        if (!order.bybitTpId && !order.bybitSlId && openOrders.length > 0) {
          const ids = openOrders.map((o) => (o.id ?? "").slice(-8));
          if (ids[0]) order.bybitTpId = ids[0];
        }
      } catch (fErr) {
        // non-fatal
      }

      const rawOrderId = (entryResp.info as any)?.orderId ?? entryResp.id;
      const rawOrderLinkId = (entryResp.info as any)?.orderLinkId;

      console.log("\n═════════════════════════════════════════════════════");
      console.log("             BYBIT LIVE ORDER PLACED                 ");
      console.log("═════════════════════════════════════════════════════");
      console.log("CCXT entryResp.id  :", entryResp.id);
      console.log("Order ID (slice-8) :", (rawOrderId ?? "").slice(-8));
      console.log("TP / SL Order IDs  :", `${order.bybitTpId ?? "—"} / ${order.bybitSlId ?? "—"}`);
      console.log("Fill Price (Bybit) :", order.entryPrice);
      console.log("Filled Size (Bybit):", order.size);
      console.log("Full Bybit response:", JSON.stringify(entryResp.info ?? entryResp, null, 2));
      console.log("═════════════════════════════════════════════════════\n");

      this.logger.info("[Engine] Live order placed", {
        entryOrderId: entryResp.id,
        bybitOrderId: (rawOrderId ?? "").slice(-8),
        tpId: order.bybitTpId,
        slId: order.bybitSlId,
        fillPrice: order.entryPrice,
        size: order.size,
        sl: order.stopLoss,
        tp: order.takeProfit,
      });
    } catch (err) {
      console.error("\n❌ [Engine] Order placement FAILED:", err);
      this.logger.error("[Engine] Order placement failed", { error: String(err) });
      order.status = OrderStatus.REJECTED;
      return null;
    }

    return order;
  }

  // ──────────────────────────────────────────────────────────
  // Public / Private: balance fetching
  // ──────────────────────────────────────────────────────────

  async fetchLiveAccountBalance(): Promise<{
    equity: number;
    walletBalance: number;
    availableBalance: number;
  }> {
    if (this.config.paperTrading) {
      const pnl = this.state.closedTrades.reduce((s, t) => s + (t.pnlRaw ?? 0), 0);
      const base = this.state.dayStartBalance > 0 ? this.state.dayStartBalance : this.config.paperBalance;
      const current = parseFloat((base + pnl).toFixed(4));
      const res = { equity: current, walletBalance: current, availableBalance: current };
      this.latestBalanceInfo = res;
      this.snapshotDayStart(current);
      return res;
    }

    try {
      const balances = await this.exchange.fetchBalance({ type: "unified" });
      const quote = this.config.symbol.split("/")[1]?.split(":")[0] ?? "USDT";

      const infoList = (balances as any)?.info?.result?.list;
      const uAccount = Array.isArray(infoList) ? infoList[0] : null;

      const totalEquity = uAccount?.totalEquity ? parseFloat(uAccount.totalEquity) : 0;
      const totalWallet = uAccount?.totalWalletBalance ? parseFloat(uAccount.totalWalletBalance) : 0;
      const totalAvail = uAccount?.totalAvailableBalance ? parseFloat(uAccount.totalAvailableBalance) : 0;

      const coinObj = uAccount?.coin?.find((c: any) => c?.coin === quote);
      const coinWallet = coinObj?.walletBalance ? parseFloat(coinObj.walletBalance) : 0;
      const coinEquity = coinObj?.equity ? parseFloat(coinObj.equity) : 0;

      const ccxtTotal = (balances?.total as unknown as Record<string, number | undefined>)?.[quote] ?? 0;
      const ccxtFree = (balances?.free as unknown as Record<string, number | undefined>)?.[quote] ?? 0;

      const finalEquity = totalEquity > 0 ? totalEquity : (coinEquity > 0 ? coinEquity : (ccxtTotal > 0 ? ccxtTotal : coinWallet));
      const finalWallet = totalWallet > 0 ? totalWallet : (coinWallet > 0 ? coinWallet : (ccxtTotal > 0 ? ccxtTotal : finalEquity));
      const finalAvail = totalAvail > 0 ? totalAvail : (ccxtFree > 0 ? ccxtFree : finalWallet);

      const res = {
        equity: parseFloat(finalEquity.toFixed(4)),
        walletBalance: parseFloat(finalWallet.toFixed(4)),
        availableBalance: parseFloat(finalAvail.toFixed(4)),
      };

      this.latestBalanceInfo = res;
      this.snapshotDayStart(res.equity > 0 ? res.equity : res.walletBalance);
      return res;
    } catch (err) {
      this.logger.error("[Engine] fetchLiveAccountBalance failed", { error: String(err) });
      return this.latestBalanceInfo;
    }
  }

  async fetchBalance(): Promise<number> {
    const live = await this.fetchLiveAccountBalance();
    return live.equity > 0 ? live.equity : live.walletBalance;
  }

  getLatestBalanceInfo(): { equity: number; walletBalance: number; availableBalance: number } {
    if (this.latestBalanceInfo.equity === 0) {
      const pnl = this.state.closedTrades.reduce((s, t) => s + (t.pnlRaw ?? 0), 0);
      const base = this.state.dayStartBalance > 0 ? this.state.dayStartBalance : this.config.paperBalance;
      const current = parseFloat((base + pnl).toFixed(4));
      return { equity: current, walletBalance: current, availableBalance: current };
    }
    return this.latestBalanceInfo;
  }

  /**
   * Snapshots the opening balance once per WAT calendar day.
   * WAT = UTC+1, so midnight WAT = 23:00 UTC previous day.
   */
  private snapshotDayStart(balance: number): void {
    const watDate = new Date(Date.now() + 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10); // YYYY-MM-DD in WAT

    if (this.state.dayStartDate !== watDate) {
      this.state.dayStartDate = watDate;
      this.state.dayStartBalance = balance;
      this.logger.info("[Engine] Day start balance snapshot", {
        date: watDate,
        balance,
      });
    }
  }
}
