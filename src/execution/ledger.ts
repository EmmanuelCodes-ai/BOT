// ============================================================
// Trade & Financial Ledger — Complete Dollar-Accurate Accounting
// Persisted in logs/ledger.json across server restarts
// ============================================================

import * as fs from "fs";
import * as path from "path";
import { Trade, TradeOutcome, SignalDirection } from "../types";

export interface PositionLedgerEntry {
  id: string;
  symbol: string;
  direction: SignalDirection;
  strategyId: string;
  size: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskUSD: number;
  targetUSD: number;
  notionalUSD: number;
  currentPrice: number;
  unrealizedPnLUSD: number;
  unrealizedPnLPct: number;
  unrealizedR: number;
  peakPnLUSD: number;
  maxAdversePnLUSD: number;
  openedAt: number;
  durationMinutes: number;
  partialRealizedUSD?: number;
  partialRealizedR?: number;
  partialRealizedPct?: number;
  isBreakeven?: boolean;
}

export interface ClosedTradeLedgerEntry {
  id: string;
  symbol: string;
  direction: SignalDirection;
  strategyId: string;
  size: number;
  entryPrice: number;
  exitPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskUSD: number;
  realizedPnLUSD: number;
  realizedPnLR: number;
  outcome: TradeOutcome;
  openedAt: number;
  closedAt: number;
  durationMinutes: number;
  partialRealizedUSD?: number;
  partialRealizedR?: number;
  partialRealizedPct?: number;
  notes: string;
}

// ------------------------------------------------------------
// Period Performance Summary (Weekly / Monthly)
// ------------------------------------------------------------

export interface PeriodTradeSummary {
  pnlUSD: number;
  pnlR: number;
  strategy: string;
  direction: string;
  outcome: string;
  durationMinutes: number;
}

export interface PeriodSummary {
  label: string;                     // "Weekly" or "Monthly"
  periodStart: string;               // ISO date string (YYYY-MM-DD)
  periodEnd: string;                 // ISO date string (YYYY-MM-DD)
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRatePct: number;                // wins / (wins+losses) * 100
  netPnLUSD: number;                 // sum of all realizedPnLUSD in period
  netPnLPct: number;                 // netPnL / startingEquity * 100
  totalR: number;                    // sum of realizedPnLR in period
  avgR: number;                      // totalR / totalTrades
  profitFactor: number;              // grossProfit / grossLoss
  bestTrade: PeriodTradeSummary | null;
  worstTrade: PeriodTradeSummary | null;
  maxDrawdownPct: number;            // max intra-period peak-to-trough drawdown
  startingEquityUSD: number;         // equity at period start
  endingEquityUSD: number;           // equity at period end (live or calculated)
}

export interface AccountFinancialSnapshot {
  startingBalanceUSD: number;
  cashBalanceUSD: number;
  lockedMarginUSD: number;
  totalEquityUSD: number;
  totalRealizedPnLUSD: number;
  totalUnrealizedPnLUSD: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakevenTrades: number;
  winRatePct: number;
  grossProfitUSD: number;
  grossLossUSD: number;
  profitFactor: number;
  expectancyUSD: number;
  peakEquityUSD: number;
  currentDrawdownUSD: number;
  currentDrawdownPct: number;
  maxDrawdownPct: number;
  lastUpdated: string;
}

interface PersistedLedgerData {
  startingBalanceUSD: number;
  peakEquityUSD: number;
  maxDrawdownPct: number;
  openPositions: PositionLedgerEntry[];
  closedTrades: ClosedTradeLedgerEntry[];
}

export class TradeLedger {
  private ledgerPath: string;
  private startingBalanceUSD: number = 0;
  private peakEquityUSD: number = 0;
  private maxDrawdownPct: number = 0;
  private openPositions: Map<string, PositionLedgerEntry> = new Map();
  private closedTrades: ClosedTradeLedgerEntry[] = [];

  constructor(logDir: string = path.resolve(process.cwd(), "logs")) {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    this.ledgerPath = path.join(logDir, "ledger.json");
    this.loadFromDisk();
  }

  // ── Initialize or update initial capital ───────────────────
  initCapital(balanceUSD: number): void {
    if (this.startingBalanceUSD === 0 && balanceUSD > 0) {
      this.startingBalanceUSD = balanceUSD;
      if (this.peakEquityUSD === 0) {
        this.peakEquityUSD = balanceUSD;
      }
      this.saveToDisk();
    }
  }

  // ── Record a newly opened trade ────────────────────────────
  recordOpen(trade: Trade, currentPrice?: number): PositionLedgerEntry {
    const markPrice = currentPrice ?? trade.entryPrice;
    const stopDist = Math.abs(trade.entryPrice - trade.stopLoss);
    const targetDist = Math.abs(trade.takeProfit - trade.entryPrice);
    const riskUSD = parseFloat((stopDist * trade.size).toFixed(4));
    const targetUSD = parseFloat((targetDist * trade.size).toFixed(4));
    const notionalUSD = parseFloat((trade.entryPrice * trade.size).toFixed(4));

    const pnlUSD = this.calculatePnL(trade.direction, trade.entryPrice, markPrice, trade.size);
    const pnlR = riskUSD > 0 ? parseFloat((pnlUSD / riskUSD).toFixed(3)) : 0;
    const pnlPct = notionalUSD > 0 ? parseFloat(((pnlUSD / notionalUSD) * 100).toFixed(3)) : 0;

    const entry: PositionLedgerEntry = {
      id: trade.id,
      symbol: trade.symbol,
      direction: trade.direction,
      strategyId: trade.strategyId,
      size: trade.size,
      entryPrice: trade.entryPrice,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
      riskUSD,
      targetUSD,
      notionalUSD,
      currentPrice: markPrice,
      unrealizedPnLUSD: pnlUSD,
      unrealizedPnLPct: pnlPct,
      unrealizedR: pnlR,
      peakPnLUSD: Math.max(0, pnlUSD),
      maxAdversePnLUSD: Math.min(0, pnlUSD),
      openedAt: trade.openedAt,
      durationMinutes: Math.round((Date.now() - trade.openedAt) / 60000),
    };

    this.openPositions.set(trade.id, entry);
    this.updateEquityAndDrawdown();
    this.saveToDisk();
    return entry;
  }

  // ── Update mark prices for open positions ──────────────────
  updateMarkPrice(currentPrice: number): void {
    if (this.openPositions.size === 0) return;

    for (const [, pos] of this.openPositions) {
      pos.currentPrice = currentPrice;
      pos.durationMinutes = Math.round((Date.now() - pos.openedAt) / 60000);
      const pnlUSD = this.calculatePnL(pos.direction, pos.entryPrice, currentPrice, pos.size);
      pos.unrealizedPnLUSD = pnlUSD;
      pos.unrealizedR = pos.riskUSD > 0 ? parseFloat((pnlUSD / pos.riskUSD).toFixed(3)) : 0;
      pos.unrealizedPnLPct = pos.notionalUSD > 0
        ? parseFloat(((pnlUSD / pos.notionalUSD) * 100).toFixed(3))
        : 0;

      if (pnlUSD > pos.peakPnLUSD) pos.peakPnLUSD = pnlUSD;
      if (pnlUSD < pos.maxAdversePnLUSD) pos.maxAdversePnLUSD = pnlUSD;
    }

    this.updateEquityAndDrawdown();
    this.saveToDisk();
  }

  // ── Record a closed trade ──────────────────────────────────
  recordClose(trade: Trade): ClosedTradeLedgerEntry {
    const exitPrice = trade.exitPrice ?? trade.entryPrice;
    const closedAt = trade.closedAt ?? Date.now();
    const durationMinutes = Math.round((closedAt - trade.openedAt) / 60000);

    const pnlUSD = trade.pnlRaw !== null
      ? parseFloat(trade.pnlRaw.toFixed(4))
      : this.calculatePnL(trade.direction, trade.entryPrice, exitPrice, trade.size);

    const stopDist = Math.abs(trade.entryPrice - trade.stopLoss);
    const riskUSD = parseFloat((stopDist * trade.size).toFixed(4));
    const pnlR = trade.pnlR !== null
      ? parseFloat(trade.pnlR.toFixed(3))
      : (riskUSD > 0 ? parseFloat((pnlUSD / riskUSD).toFixed(3)) : 0);

    const closedEntry: ClosedTradeLedgerEntry = {
      id: trade.id,
      symbol: trade.symbol,
      direction: trade.direction,
      strategyId: trade.strategyId,
      size: trade.size,
      entryPrice: trade.entryPrice,
      exitPrice,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
      riskUSD,
      realizedPnLUSD: pnlUSD,
      realizedPnLR: pnlR,
      outcome: trade.outcome,
      openedAt: trade.openedAt,
      closedAt,
      durationMinutes,
      partialRealizedUSD: trade.partialPnlRaw,
      partialRealizedR: trade.partialPnlR,
      partialRealizedPct: trade.partialPnlPct,
      notes: trade.notes,
    };

    this.openPositions.delete(trade.id);
    this.closedTrades.push(closedEntry);
    this.updateEquityAndDrawdown();
    this.saveToDisk();
    return closedEntry;
  }

  // ── Record a partial profit close ──────────────────────────
  recordPartialClose(
    trade: Trade,
    closedSize: number,
    exitPrice: number,
    pnlUSD: number,
    pnlR: number,
    newStopLoss: number,
    pnlPct?: number
  ): void {
    const pos = this.openPositions.get(trade.id);
    if (!pos) return;

    pos.size = parseFloat((pos.size - closedSize).toFixed(8));
    pos.stopLoss = newStopLoss;
    pos.isBreakeven = true;
    pos.partialRealizedUSD = parseFloat(((pos.partialRealizedUSD ?? 0) + pnlUSD).toFixed(4));
    pos.partialRealizedR = parseFloat(((pos.partialRealizedR ?? 0) + pnlR).toFixed(3));
    if (pnlPct !== undefined) {
      pos.partialRealizedPct = parseFloat(((pos.partialRealizedPct ?? 0) + pnlPct).toFixed(2));
    }

    const stopDist = Math.abs(pos.entryPrice - pos.stopLoss);
    pos.riskUSD = parseFloat((stopDist * pos.size).toFixed(4));
    pos.notionalUSD = parseFloat((pos.entryPrice * pos.size).toFixed(4));

    this.updateEquityAndDrawdown();
    this.saveToDisk();
  }

  // ── Record an incremental stepped stop-loss close ───────────
  recordSteppedStopClose(
    trade: Trade,
    closedSize: number,
    exitPrice: number,
    pnlUSD: number,
    pnlR: number,
    newStopLoss: number,
    stepRatio: number
  ): void {
    const pos = this.openPositions.get(trade.id);
    if (!pos) return;

    pos.size = parseFloat((pos.size - closedSize).toFixed(8));
    pos.stopLoss = newStopLoss;
    pos.partialRealizedUSD = parseFloat(((pos.partialRealizedUSD ?? 0) + pnlUSD).toFixed(4));
    pos.partialRealizedR = parseFloat(((pos.partialRealizedR ?? 0) + pnlR).toFixed(3));

    const stopDist = Math.abs(pos.entryPrice - pos.stopLoss);
    pos.riskUSD = parseFloat((stopDist * pos.size).toFixed(4));
    pos.notionalUSD = parseFloat((pos.entryPrice * pos.size).toFixed(4));

    this.updateEquityAndDrawdown();
    this.saveToDisk();
  }

  // ── Get financial snapshot ─────────────────────────────────
  getFinancialSnapshot(live?: { equity: number; walletBalance: number; availableBalance: number } | number): AccountFinancialSnapshot {
    const liveObj = typeof live === "number"
      ? { equity: live, walletBalance: live, availableBalance: live }
      : live;

    const openPartialRealized = Array.from(this.openPositions.values())
      .reduce((acc, p) => acc + (p.partialRealizedUSD ?? 0), 0);
    const realizedPnL = parseFloat(
      (this.closedTrades.reduce((acc, t) => acc + t.realizedPnLUSD, 0) + openPartialRealized).toFixed(4)
    );
    const unrealizedPnL = parseFloat(
      Array.from(this.openPositions.values())
        .reduce((acc, p) => acc + p.unrealizedPnLUSD, 0)
        .toFixed(4)
    );

    const starting = this.startingBalanceUSD > 0
      ? this.startingBalanceUSD
      : (liveObj?.walletBalance ?? liveObj?.equity ?? 10000);

    const totalEquity = liveObj && liveObj.equity > 0
      ? parseFloat(liveObj.equity.toFixed(4))
      : parseFloat((starting + realizedPnL + unrealizedPnL).toFixed(4));

    const cashBalance = liveObj && liveObj.availableBalance > 0
      ? parseFloat(liveObj.availableBalance.toFixed(4))
      : parseFloat((starting + realizedPnL).toFixed(4));

    const lockedMargin = parseFloat(
      Array.from(this.openPositions.values())
        .reduce((acc, p) => acc + p.notionalUSD, 0)
        .toFixed(4)
    );

    const winning = this.closedTrades.filter((t) => t.outcome === TradeOutcome.WIN);
    const losing = this.closedTrades.filter((t) => t.outcome === TradeOutcome.LOSS);
    const be = this.closedTrades.filter((t) => t.outcome === TradeOutcome.BREAKEVEN);

    const grossProfit = parseFloat(
      winning.reduce((acc, t) => acc + Math.max(0, t.realizedPnLUSD), 0).toFixed(4)
    );
    const grossLoss = parseFloat(
      Math.abs(losing.reduce((acc, t) => acc + Math.min(0, t.realizedPnLUSD), 0)).toFixed(4)
    );

    const winRatePct = this.closedTrades.length > 0
      ? parseFloat(((winning.length / this.closedTrades.length) * 100).toFixed(1))
      : 0;

    const profitFactor = grossLoss > 0
      ? parseFloat((grossProfit / grossLoss).toFixed(2))
      : grossProfit > 0 ? 999 : 0;

    const expectancy = this.closedTrades.length > 0
      ? parseFloat((realizedPnL / this.closedTrades.length).toFixed(4))
      : 0;

    const peak = Math.max(this.peakEquityUSD, totalEquity, starting);
    const currentDrawdownUSD = parseFloat(Math.max(0, peak - totalEquity).toFixed(4));
    const currentDrawdownPct = peak > 0
      ? parseFloat(((currentDrawdownUSD / peak) * 100).toFixed(2))
      : 0;

    return {
      startingBalanceUSD: starting,
      cashBalanceUSD: cashBalance,
      lockedMarginUSD: lockedMargin,
      totalEquityUSD: totalEquity,
      totalRealizedPnLUSD: realizedPnL,
      totalUnrealizedPnLUSD: unrealizedPnL,
      totalTrades: this.closedTrades.length,
      winningTrades: winning.length,
      losingTrades: losing.length,
      breakevenTrades: be.length,
      winRatePct,
      grossProfitUSD: grossProfit,
      grossLossUSD: grossLoss,
      profitFactor,
      expectancyUSD: expectancy,
      peakEquityUSD: peak,
      currentDrawdownUSD,
      currentDrawdownPct,
      maxDrawdownPct: Math.max(this.maxDrawdownPct, currentDrawdownPct),
      lastUpdated: new Date().toISOString(),
    };
  }

  getOpenPositions(): PositionLedgerEntry[] {
    return Array.from(this.openPositions.values());
  }

  getClosedTrades(): ClosedTradeLedgerEntry[] {
    return this.closedTrades;
  }

  // ── Period performance summaries ───────────────────────────

  /**
   * Aggregates all trades closed within the last 7 rolling days
   * into a PeriodSummary. Pass the current live equity so the
   * ending balance reflects the real account state.
   */
  getWeeklySummary(liveEquity?: number): PeriodSummary {
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const startDate = new Date(weekAgo).toISOString().slice(0, 10);
    const endDate   = new Date(now).toISOString().slice(0, 10);
    const trades = this.closedTrades.filter((t) => t.closedAt >= weekAgo);
    return this.buildPeriodSummary("Weekly (Last 7 Days)", startDate, endDate, trades, liveEquity);
  }

  /**
   * Aggregates all trades closed within the current calendar month
   * (UTC) into a PeriodSummary.
   */
  getMonthlySummary(liveEquity?: number): PeriodSummary {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
    const startDate = monthStart.toISOString().slice(0, 10);
    const endDate   = now.toISOString().slice(0, 10);
    const trades = this.closedTrades.filter((t) => t.closedAt >= monthStart.getTime());
    const monthName = now.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    return this.buildPeriodSummary(`Monthly (${monthName})`, startDate, endDate, trades, liveEquity);
  }

  // ── Private: shared period aggregation ───────────────────

  private buildPeriodSummary(
    label: string,
    periodStart: string,
    periodEnd: string,
    trades: ClosedTradeLedgerEntry[],
    liveEquity?: number
  ): PeriodSummary {
    const wins       = trades.filter((t) => t.outcome === TradeOutcome.WIN);
    const losses     = trades.filter((t) => t.outcome === TradeOutcome.LOSS);
    const breakevens = trades.filter((t) => t.outcome === TradeOutcome.BREAKEVEN);

    const winRatePct = wins.length + losses.length > 0
      ? parseFloat(((wins.length / (wins.length + losses.length)) * 100).toFixed(1))
      : 0;

    const netPnLUSD = parseFloat(
      trades.reduce((acc, t) => acc + t.realizedPnLUSD, 0).toFixed(4)
    );
    const totalR = parseFloat(
      trades.reduce((acc, t) => acc + t.realizedPnLR, 0).toFixed(3)
    );
    const avgR = trades.length > 0
      ? parseFloat((totalR / trades.length).toFixed(3))
      : 0;

    const grossProfit = parseFloat(
      wins.reduce((acc, t) => acc + Math.max(0, t.realizedPnLUSD), 0).toFixed(4)
    );
    const grossLoss = parseFloat(
      Math.abs(losses.reduce((acc, t) => acc + Math.min(0, t.realizedPnLUSD), 0)).toFixed(4)
    );
    const profitFactor = grossLoss > 0
      ? parseFloat((grossProfit / grossLoss).toFixed(2))
      : (grossProfit > 0 ? 999 : 0);

    // Best and worst trades
    let bestTrade: PeriodTradeSummary | null = null;
    let worstTrade: PeriodTradeSummary | null = null;
    if (trades.length > 0) {
      const sorted = [...trades].sort((a, b) => b.realizedPnLUSD - a.realizedPnLUSD);
      const best  = sorted[0];
      const worst = sorted[sorted.length - 1];
      bestTrade = {
        pnlUSD: best.realizedPnLUSD,
        pnlR: best.realizedPnLR,
        strategy: best.strategyId,
        direction: best.direction,
        outcome: best.outcome,
        durationMinutes: best.durationMinutes,
      };
      worstTrade = {
        pnlUSD: worst.realizedPnLUSD,
        pnlR: worst.realizedPnLR,
        strategy: worst.strategyId,
        direction: worst.direction,
        outcome: worst.outcome,
        durationMinutes: worst.durationMinutes,
      };
    }

    // Intra-period max drawdown — walk through trades in time order
    // tracking cumulative PnL high-water mark
    let maxDrawdownPct = 0;
    let runningPnL = 0;
    let peakRunningPnL = 0;
    const periodTradesChron = [...trades].sort((a, b) => a.closedAt - b.closedAt);
    for (const t of periodTradesChron) {
      runningPnL += t.realizedPnLUSD;
      if (runningPnL > peakRunningPnL) peakRunningPnL = runningPnL;
      const drawdown = peakRunningPnL > 0
        ? ((peakRunningPnL - runningPnL) / Math.abs(peakRunningPnL)) * 100
        : 0;
      if (drawdown > maxDrawdownPct) maxDrawdownPct = drawdown;
    }
    maxDrawdownPct = parseFloat(maxDrawdownPct.toFixed(2));

    // Equity anchors
    const snap = this.getFinancialSnapshot();
    const endingEquity = liveEquity && liveEquity > 0
      ? liveEquity
      : snap.totalEquityUSD;
    const startingEquity = parseFloat(Math.max(0, endingEquity - netPnLUSD).toFixed(4));
    const netPnLPct = startingEquity > 0
      ? parseFloat(((netPnLUSD / startingEquity) * 100).toFixed(2))
      : 0;

    return {
      label,
      periodStart,
      periodEnd,
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      breakevens: breakevens.length,
      winRatePct,
      netPnLUSD,
      netPnLPct,
      totalR,
      avgR,
      profitFactor,
      bestTrade,
      worstTrade,
      maxDrawdownPct,
      startingEquityUSD: startingEquity,
      endingEquityUSD: endingEquity,
    };
  }

  // ── Private helpers ────────────────────────────────────────

  private calculatePnL(
    direction: SignalDirection,
    entryPrice: number,
    currentPrice: number,
    size: number
  ): number {
    const raw = direction === SignalDirection.LONG
      ? (currentPrice - entryPrice) * size
      : (entryPrice - currentPrice) * size;
    return parseFloat(raw.toFixed(4));
  }

  private updateEquityAndDrawdown(): void {
    const snap = this.getFinancialSnapshot();
    if (snap.totalEquityUSD > this.peakEquityUSD) {
      this.peakEquityUSD = snap.totalEquityUSD;
    }
    if (snap.currentDrawdownPct > this.maxDrawdownPct) {
      this.maxDrawdownPct = snap.currentDrawdownPct;
    }
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.ledgerPath)) {
        const raw = fs.readFileSync(this.ledgerPath, "utf8");
        const data: PersistedLedgerData = JSON.parse(raw);
        this.startingBalanceUSD = data.startingBalanceUSD || 0;
        this.peakEquityUSD = data.peakEquityUSD || 0;
        this.maxDrawdownPct = data.maxDrawdownPct || 0;

        if (Array.isArray(data.openPositions)) {
          this.openPositions = new Map(data.openPositions.map((p) => [p.id, p]));
        }
        if (Array.isArray(data.closedTrades)) {
          this.closedTrades = data.closedTrades;
        }
      }
    } catch (err) {
      console.error("[Ledger] Failed to load ledger from disk:", err);
    }
  }

  private saveToDisk(): void {
    try {
      const data: PersistedLedgerData = {
        startingBalanceUSD: this.startingBalanceUSD,
        peakEquityUSD: this.peakEquityUSD,
        maxDrawdownPct: this.maxDrawdownPct,
        openPositions: Array.from(this.openPositions.values()),
        closedTrades: this.closedTrades,
      };
      fs.writeFileSync(this.ledgerPath, JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
      console.error("[Ledger] Failed to save ledger to disk:", err);
    }
  }
}
