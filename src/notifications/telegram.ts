// ============================================================
// Telegram Notifier
// Sends trade and session updates directly to your phone.
// ============================================================

import * as https from "https";

const TELEGRAM_API = "https://api.telegram.org";

function sendMessage(token: string, chatId: string, text: string): void {
  const body = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  });

  const url = new URL(`${TELEGRAM_API}/bot${token}/sendMessage`);

  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  };

  const req = https.request(options, (res) => {
    if (res.statusCode !== 200) {
      console.error(`[Telegram] Failed to send message: ${res.statusCode}`);
    }
  });

  req.on("error", (err) => {
    console.error("[Telegram] Request error:", err.message);
  });

  req.write(body);
  req.end();
}

export class TelegramNotifier {
  private token: string;
  private chatId: string;
  private enabled: boolean;

  constructor() {
    this.token = process.env.TELEGRAM_TOKEN ?? "";
    this.chatId = process.env.TELEGRAM_CHAT_ID ?? "";
    this.enabled = Boolean(this.token && this.chatId);

    if (!this.enabled) {
      console.warn("[Telegram] Token or chat ID missing — notifications disabled");
    }
  }

  notifyTradeOpen(params: {
    id: string;
    exchangeOrderId: string | null;
    strategy: string;
    direction: string;
    symbol: string;
    entry: number;
    stopLoss: number;
    takeProfit: number;
    size: number;
    flow: string;
    score: number;
    tpOrderId?: string;
    slOrderId?: string;
  }): void {
    if (!this.enabled) return;

    const emoji = params.direction === "LONG" ? "🟢" : "🔴";
    const rawId = params.exchangeOrderId ?? "";
    const bybitOrderId = rawId.startsWith("PAPER") ? "PAPER" : (rawId.slice(-8) || "—");

    const header = `${emoji} <b>AUTOMATED STRATEGY TRADE OPENED</b>\n<i>(Triggered automatically by strategy signal)</i>`;

    let ids = `Order ID  : <code>${bybitOrderId}</code> (Order History)\n`;
    if (params.tpOrderId || params.slOrderId) {
      ids += `TP/SL IDs : <code>${[params.tpOrderId, params.slOrderId].filter(Boolean).join(" / ")}</code> (TP/SL tab)\n`;
    }
    ids += `Full UUID : <code>${rawId || "—"}</code>`;

    const msg =
      `${header}\n\n` +
      `Strategy  : ${params.strategy}\n` +
      `Direction : ${params.direction}\n` +
      `Symbol    : ${params.symbol}\n` +
      `Entry     : ${params.entry} (Bybit API Fill)\n` +
      `Stop Loss : ${params.stopLoss}\n` +
      `Take Profit: ${params.takeProfit}\n` +
      `Size      : ${params.size}\n` +
      `Flow      : ${params.flow}\n` +
      `Score     : ${params.score}\n\n` +
      ids + `\n` +
      `Bot ID    : ${params.id.slice(0, 8)}`;

    sendMessage(this.token, this.chatId, msg);
  }

  notifyPartialHarvest(params: {
    id: string;
    symbol: string;
    direction: string;
    harvestPrice: number;
    bankedPnlRaw: number;
    profitPct?: number;
    bankedPnlR?: number;
    remainingSize: number;
    breakevenPrice: number;
    strategy: string;
  }): void {
    if (!this.enabled) return;

    const pnlSign = params.bankedPnlRaw >= 0 ? "+" : "";
    const pctStr = params.profitPct !== undefined
      ? `+${params.profitPct.toFixed(2)}% ROI`
      : (params.bankedPnlR !== undefined ? `${pnlSign}${params.bankedPnlR.toFixed(2)}R` : "");

    const msg =
      `🎯 <b>EARLY PARTIAL PROFIT HARVESTED (${pctStr})</b>\n\n` +
      `Strategy     : ${params.strategy}\n` +
      `Symbol       : ${params.symbol} (${params.direction})\n` +
      `Harvest Price: ${params.harvestPrice} (${pctStr})\n` +
      `Banked Cash  : <b>${pnlSign}$${params.bankedPnlRaw.toFixed(4)}</b> (${pctStr})\n` +
      `Remaining Pos: ${params.remainingSize}\n` +
      `🛡️ Stop Loss : <b>${params.breakevenPrice}</b> (Moved to Breakeven + Fee Buffer)\n\n` +
      `Status       : <b>100% RISK-FREE TRADE 🛡️</b>\n` +
      `Bot ID       : ${params.id.slice(0, 8)}`;

    sendMessage(this.token, this.chatId, msg);
  }

  notifySteppedStopClose(params: {
    id: string;
    symbol: string;
    direction: string;
    exitPrice: number;
    closedSize: number;
    remainingSize: number;
    lossRaw: number;
    stepRatio: number;
    newStopLoss: number;
    strategy: string;
  }): void {
    if (!this.enabled) return;

    const msg =
      `⚠️ <b>STEPPED STOP-LOSS TRANCHE EXECUTED (${Math.round(params.stepRatio * 100)}% Adverse)</b>\n\n` +
      `Strategy     : ${params.strategy}\n` +
      `Symbol       : ${params.symbol} (${params.direction})\n` +
      `Exit Price   : ${params.exitPrice} (Limit Order Maker)\n` +
      `Closed Size  : ${params.closedSize}\n` +
      `Remaining Pos: ${params.remainingSize}\n` +
      `Realized PnL : -$${Math.abs(params.lossRaw).toFixed(4)}\n` +
      `New Stop Loss: ${params.newStopLoss}\n\n` +
      `Action       : <b>De-risked position early to avoid full blowout 🛡️</b>\n` +
      `Bot ID       : ${params.id.slice(0, 8)}`;

    sendMessage(this.token, this.chatId, msg);
  }

  notifyTrailingStopUpdate(params: {
    id: string;
    symbol: string;
    direction: string;
    peakPrice: number;
    newStopLoss: number;
    lockedInRoiPct: number;
    strategy: string;
  }): void {
    if (!this.enabled) return;

    const msg =
      `📈 <b>DYNAMIC TRAILING STOP ADJUSTED</b>\n\n` +
      `Strategy     : ${params.strategy}\n` +
      `Symbol       : ${params.symbol} (${params.direction})\n` +
      `Peak Price   : ${params.peakPrice}\n` +
      `New Stop Loss: <b>${params.newStopLoss}</b> (Trailing)\n` +
      `Locked-in ROI: +${params.lockedInRoiPct.toFixed(2)}%\n\n` +
      `Status       : <b>Gains locked in 🛡️</b>\n` +
      `Bot ID       : ${params.id.slice(0, 8)}`;

    sendMessage(this.token, this.chatId, msg);
  }

  notifyTradeClose(params: {
    id: string;
    exchangeOrderId?: string | null;
    outcome: string;
    pnlRaw: number;
    pnlR: number;
    exitPrice: number;
    strategy: string;
    durationMin: number;
    partialPnlRaw?: number;
    partialPnlR?: number;
    partialPnlPct?: number;
  }): void {
    if (!this.enabled) return;

    const emoji =
      params.outcome === "WIN" ? "✅" :
      params.outcome === "LOSS" ? "❌" : "🛡️";

    const pnlSign = params.pnlRaw >= 0 ? "+" : "";
    const rawId = params.exchangeOrderId ?? "";
    const bybitOrderId = rawId.startsWith("PAPER") ? "PAPER" : (rawId.slice(-8) || "—");

    const header = `${emoji} <b>AUTOMATED STRATEGY TRADE CLOSED — ${params.outcome}</b>`;

    let partialInfo = "";
    if (params.partialPnlRaw !== undefined && params.partialPnlRaw > 0) {
      const pctStr = params.partialPnlPct !== undefined
        ? ` (+${params.partialPnlPct.toFixed(2)}%)`
        : (params.partialPnlR !== undefined ? ` (+${params.partialPnlR.toFixed(2)}R)` : "");
      partialInfo = `Partials Banked: +$${params.partialPnlRaw.toFixed(4)}${pctStr}\n`;
    }

    const msg =
      `${header}\n\n` +
      `Strategy  : ${params.strategy}\n` +
      `Exit      : ${params.exitPrice} (Bybit API Fill)\n` +
      partialInfo +
      `Total PnL : ${pnlSign}${params.pnlRaw.toFixed(4)} (${pnlSign}${params.pnlR.toFixed(2)}R)\n` +
      `Duration  : ${params.durationMin}m\n\n` +
      `Order ID  : <code>${bybitOrderId}</code> (Order History)\n` +
      `Full UUID : <code>${rawId || "—"}</code>\n` +
      `Bot ID    : ${params.id.slice(0, 8)}`;

    sendMessage(this.token, this.chatId, msg);
  }

  notifySessionSummary(params: {
    date: string;
    totalTrades: number;
    wins: number;
    losses: number;
    totalR: number;
    totalPnl: number;
    winRate: string;
    openingBalance: number;
    closingBalance: number;
  }): void {
    if (!this.enabled) return;

    const emoji = params.totalR >= 0 ? "📈" : "📉";
    const balanceChange = params.closingBalance - params.openingBalance;
    const balanceChangePct =
      params.openingBalance > 0
        ? ((balanceChange / params.openingBalance) * 100).toFixed(2)
        : "0.00";
    const balSign = balanceChange >= 0 ? "+" : "";

    const msg =
      `${emoji} <b>DAILY SUMMARY</b>\n` +
      `${params.date}\n\n` +
      `💰 <b>Account</b>\n` +
      `Opening  : $${params.openingBalance.toFixed(2)}\n` +
      `Closing  : $${params.closingBalance.toFixed(2)}\n` +
      `Change   : ${balSign}$${balanceChange.toFixed(2)} (${balSign}${balanceChangePct}%)\n\n` +
      `📊 <b>Performance</b>\n` +
      `Trades   : ${params.totalTrades}\n` +
      `Wins     : ${params.wins}\n` +
      `Losses   : ${params.losses}\n` +
      `Win Rate : ${params.winRate}%\n` +
      `Total R  : ${params.totalR >= 0 ? "+" : ""}${params.totalR.toFixed(2)}R\n` +
      `Total PnL: ${params.totalPnl >= 0 ? "+" : ""}$${params.totalPnl.toFixed(4)}`;

    sendMessage(this.token, this.chatId, msg);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  notifyBotStarted(symbol: string, session: string): void {
    if (!this.enabled) return;
    sendMessage(
      this.token,
      this.chatId,
      `🤖 <b>Bot Started</b>\nSymbol: ${symbol}\nSession: ${session}`
    );
  }

  notifyAnalyst(message: string): void {
    if (!this.enabled) return;
    sendMessage(this.token, this.chatId, message);
  }

  notifyError(message: string): void {
    if (!this.enabled) return;
    sendMessage(this.token, this.chatId, `⚠️ <b>Bot Alert</b>\n${message}`);
  }

  /**
   * Sent when the pre-entry market-regime filter blocks a valid strategy
   * signal. Provides full diagnostic telemetry so threshold tuning can
   * be done from Telegram without needing to check the logs.
   */
  notifyPreEntryFilterBlock(params: {
    strategy: string;
    direction: string;
    symbol: string;
    reason: string;
    volumeMultiplier: number;
    minVolumeMultiplier: number;
    bbBandwidth: number;
    minBollingerBandwidth: number;
    atrExpansionRatio: number;
    minATRExpansionRatio: number;
    isStrategyAware: boolean;
  }): void {
    if (!this.enabled) return;

    const volOk  = params.volumeMultiplier  >= params.minVolumeMultiplier  ? "✅" : "❌";
    const bwOk   = params.bbBandwidth       >= params.minBollingerBandwidth ? "✅" : "❌";
    const atrOk  = params.atrExpansionRatio >= params.minATRExpansionRatio  ? "✅" : "❌";
    const modeTag = params.isStrategyAware ? " <i>(strategy-aware thresholds)</i>" : "";

    const msg =
      `🚫 <b>Signal Filtered — Pre-Entry Gate</b>${modeTag}\n` +
      `Strategy : ${params.strategy} ${params.direction}\n` +
      `Symbol   : ${params.symbol}\n\n` +
      `<b>Reason:</b> ${params.reason}\n\n` +
      `<b>Metrics vs Thresholds:</b>\n` +
      `${volOk} Volume    : ${params.volumeMultiplier.toFixed(2)}x  (min ${params.minVolumeMultiplier.toFixed(2)}x)\n` +
      `${bwOk} BB Width  : ${params.bbBandwidth.toFixed(5)}  (min ${params.minBollingerBandwidth.toFixed(5)})\n` +
      `${atrOk} ATR Ratio : ${params.atrExpansionRatio.toFixed(3)}  (min ${params.minATRExpansionRatio.toFixed(3)})`;

    sendMessage(this.token, this.chatId, msg);
  }

  /**
   * Renders a weekly or monthly performance report as a richly formatted
   * Telegram HTML message. Works for both scheduled auto-reports and
   * on-demand /weekly and /monthly slash commands.
   */
  notifyPeriodSummary(params: {
    label: string;
    periodStart: string;
    periodEnd: string;
    totalTrades: number;
    wins: number;
    losses: number;
    breakevens: number;
    winRatePct: number;
    netPnLUSD: number;
    netPnLPct: number;
    totalR: number;
    avgR: number;
    profitFactor: number;
    bestTrade: { pnlUSD: number; pnlR: number; strategy: string; direction: string; durationMinutes: number } | null;
    worstTrade: { pnlUSD: number; pnlR: number; strategy: string; direction: string; durationMinutes: number } | null;
    maxDrawdownPct: number;
    startingEquityUSD: number;
    endingEquityUSD: number;
  }): void {
    if (!this.enabled) return;

    const isWeekly = params.label.toLowerCase().includes("week");
    const headerEmoji = isWeekly ? "📅" : "🗓️";
    const pnlPositive = params.netPnLUSD >= 0;
    const pnlEmoji = pnlPositive ? "📈" : "📉";
    const pnlSign = pnlPositive ? "+" : "";
    const pnlPctSign = params.netPnLPct >= 0 ? "+" : "";
    const equityChange = params.endingEquityUSD - params.startingEquityUSD;
    const equitySign = equityChange >= 0 ? "+" : "";

    // Win rate, profit factor, and drawdown tier badges
    const wrEmoji = params.winRatePct >= 60 ? "🔥" : params.winRatePct >= 45 ? "✅" : "⚠️";
    const pfEmoji = params.profitFactor >= 1.5 ? "🏆" : params.profitFactor >= 1.0 ? "✅" : "❌";
    const ddEmoji = params.maxDrawdownPct <= 2 ? "🛡️" : params.maxDrawdownPct <= 5 ? "⚠️" : "🔴";

    const summaryTitle = isWeekly
      ? `${headerEmoji} <b>WEEKLY PERFORMANCE REPORT</b>`
      : `${headerEmoji} <b>MONTHLY PERFORMANCE REPORT</b>`;

    let bestTradeStr = "No trades closed this period.";
    let worstTradeStr = "No trades closed this period.";
    if (params.bestTrade) {
      const bSign = params.bestTrade.pnlUSD >= 0 ? "+" : "";
      bestTradeStr = `${bSign}$${params.bestTrade.pnlUSD.toFixed(2)} (${bSign}${params.bestTrade.pnlR.toFixed(2)}R) · ${params.bestTrade.strategy} ${params.bestTrade.direction} · ${params.bestTrade.durationMinutes}m`;
    }
    if (params.worstTrade) {
      const wSign = params.worstTrade.pnlUSD >= 0 ? "+" : "";
      worstTradeStr = `${wSign}$${params.worstTrade.pnlUSD.toFixed(2)} (${wSign}${params.worstTrade.pnlR.toFixed(2)}R) · ${params.worstTrade.strategy} ${params.worstTrade.direction} · ${params.worstTrade.durationMinutes}m`;
    }

    const tradesLine = params.totalTrades > 0
      ? `${params.totalTrades} trades  (✅ ${params.wins}W · ❌ ${params.losses}L · 🛡️ ${params.breakevens}BE)`
      : "0 trades taken this period.";

    const msg =
      `${summaryTitle}\n` +
      `<i>${params.periodStart} → ${params.periodEnd}</i>\n\n` +
      `${pnlEmoji} <b>Net PnL</b>: <b>${pnlSign}$${params.netPnLUSD.toFixed(2)}</b>  (${pnlPctSign}${params.netPnLPct.toFixed(2)}%)\n` +
      `📊 <b>R-Performance</b>: ${params.totalR >= 0 ? "+" : ""}${params.totalR.toFixed(2)}R total · ${params.avgR >= 0 ? "+" : ""}${params.avgR.toFixed(2)}R avg/trade\n\n` +
      `💰 <b>Account</b>\n` +
      `• Start Equity   : $${params.startingEquityUSD.toFixed(2)}\n` +
      `• End Equity     : $${params.endingEquityUSD.toFixed(2)}\n` +
      `• Change         : ${equitySign}$${equityChange.toFixed(2)}\n\n` +
      `📋 <b>Trade Record</b>\n` +
      `• ${tradesLine}\n` +
      `• ${wrEmoji} Win Rate       : ${params.winRatePct.toFixed(1)}%\n` +
      `• ${pfEmoji} Profit Factor  : ${params.profitFactor === 999 ? "∞" : params.profitFactor.toFixed(2)}\n\n` +
      `🏅 <b>Best Trade</b>\n` +
      `<code>${bestTradeStr}</code>\n\n` +
      `💀 <b>Worst Trade</b>\n` +
      `<code>${worstTradeStr}</code>\n\n` +
      `${ddEmoji} <b>Max Intra-Period Drawdown</b>: ${params.maxDrawdownPct.toFixed(2)}%`;

    sendMessage(this.token, this.chatId, msg);
  }

  /**
   * Sent whenever the autonomous risk governor evaluates an aggression tier.
   * Reports Account State, Selected Mode, Sizing Rationale, and Technical Confluence.
   */
  notifyAdaptiveRiskDecision(params: {
    mode: "GROWTH" | "DEFENSE" | "PROFIT_LOCK";
    approved: boolean;
    allocatedMarginUSD: number;
    reason: string;
    strategy: string;
    direction: string;
    symbol: string;
    score: number;
    flow: string;
    macroBias: string;
    rsi: number;
    sessionPnLUSD: number;
    sessionPnLR: number;
    peakEquityUSD: number;
    drawdownPct: number;
    consecutiveWins: number;
    consecutiveLosses: number;
  }): void {
    if (!this.enabled) return;

    let modeEmoji = "🛡️";
    let modeBadge = "MODE B: CONSOLIDATION / DEFENSE (Yellow Zone)";

    if (params.mode === "GROWTH") {
      modeEmoji = "🚀";
      modeBadge = "MODE A: GROWTH / PROFIT-HUNTING (Green Zone)";
    } else if (params.mode === "PROFIT_LOCK") {
      modeEmoji = "🔒";
      modeBadge = "MODE C: PROFIT-LOCK & STAND DOWN (Red Zone)";
    }

    const pnlSign = params.sessionPnLUSD >= 0 ? "+" : "";
    const streakStr = params.consecutiveWins > 0
      ? `${params.consecutiveWins} consecutive wins 🔥`
      : (params.consecutiveLosses > 0 ? `${params.consecutiveLosses} consecutive losses ⚠️` : "Neutral");

    const statusBadge = params.approved ? "✅ <b>TRADE APPROVED & SIZED</b>" : "⛔ <b>TRADE BLOCKED (CAPITAL DEFENSE)</b>";

    const msg =
      `${modeEmoji} <b>AUTONOMOUS TRADE COMMANDER</b>\n` +
      `<b>${modeBadge}</b>\n\n` +
      `${statusBadge}\n` +
      `Strategy     : ${params.strategy} (${params.direction})\n` +
      `Symbol       : ${params.symbol}\n` +
      `Allocated    : $${params.allocatedMarginUSD.toFixed(2)} Margin\n\n` +
      `📊 <b>Account & Profit State:</b>\n` +
      `• Session PnL: ${pnlSign}$${params.sessionPnLUSD.toFixed(2)} (${pnlSign}${params.sessionPnLR.toFixed(2)}R)\n` +
      `• Peak Equity: $${params.peakEquityUSD.toFixed(2)} (DD: ${params.drawdownPct.toFixed(1)}%)\n` +
      `• Streak     : ${streakStr}\n\n` +
      `💡 <b>Sizing & Mode Rationale:</b>\n` +
      `<i>${params.reason}</i>\n\n` +
      `🎯 <b>Technical Confluence:</b>\n` +
      `• Strategy Score: ${params.score}/100\n` +
      `• Market Flow   : ${params.flow} | Macro: ${params.macroBias}\n` +
      `• RSI(14)       : ${params.rsi.toFixed(1)}`;

    sendMessage(this.token, this.chatId, msg);
  }
}

