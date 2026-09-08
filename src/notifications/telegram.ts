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
  }): void {
    if (!this.enabled) return;

    const emoji = params.direction === "LONG" ? "🟢" : "🔴";
    const rawId = params.exchangeOrderId ?? "";
    const bybitId = rawId.startsWith("PAPER") ? "PAPER" : (rawId.slice(0, 8) || "—");
    const msg =
      `${emoji} <b>TRADE OPENED</b>\n\n` +
      `Strategy : ${params.strategy}\n` +
      `Direction : ${params.direction}\n` +
      `Symbol   : ${params.symbol}\n` +
      `Entry    : ${params.entry}\n` +
      `Stop Loss: ${params.stopLoss}\n` +
      `Take Profit: ${params.takeProfit}\n` +
      `Size     : ${params.size}\n` +
      `Flow     : ${params.flow}\n` +
      `Score    : ${params.score}\n` +
      `Bybit ID : <code>${bybitId}</code>\n` +
      `Bot ID   : ${params.id.slice(0, 8)}`;

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
  }): void {
    if (!this.enabled) return;

    const emoji =
      params.outcome === "WIN" ? "✅" :
      params.outcome === "LOSS" ? "❌" : "⚪";

    const pnlSign = params.pnlRaw >= 0 ? "+" : "";
    const rawId = params.exchangeOrderId ?? "";
    const bybitId = rawId.startsWith("PAPER") ? "PAPER" : (rawId.slice(0, 8) || "—");

    const msg =
      `${emoji} <b>TRADE CLOSED — ${params.outcome}</b>\n\n` +
      `Strategy : ${params.strategy}\n` +
      `Exit     : ${params.exitPrice}\n` +
      `PnL      : ${pnlSign}${params.pnlRaw.toFixed(4)} (${pnlSign}${params.pnlR.toFixed(2)}R)\n` +
      `Duration : ${params.durationMin}m\n` +
      `Bybit ID : <code>${bybitId}</code>\n` +
      `Bot ID   : ${params.id.slice(0, 8)}`;

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
}
