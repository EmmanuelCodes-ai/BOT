// ============================================================
// AI Analyst — powered by Kimi K3 via NVIDIA NIM
//
// Model: moonshotai/kimi-k3
// API: https://integrate.api.nvidia.com/v1/chat/completions
// ============================================================

import * as https from "https";

const NIM_HOST = "integrate.api.nvidia.com";
const NIM_PATH = "/v1/chat/completions";
const MODEL = "moonshotai/kimi-k3";

// ── Bot context snapshot & telemetry ────────────────────────

export interface CandleSummary {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  type: "BULLISH" | "BEARISH" | "DOJI";
  changePct: number;
}

export interface TechnicalsSummary {
  price: number;
  ema9: number;
  ema21: number;
  ema50: number;
  ema200: number;
  emaAlignment: string;
  rsi14: number;
  rsiStatus: string;
  atr14: number;
  vwap: number;
  vwapDeviationPct: number;
  bollingerUpper: number;
  bollingerMiddle: number;
  bollingerLower: number;
  bollingerBandwidthPct: number;
  bollingerPercentB: number;
  volumeMultiplier: number;
}

export interface MultiTimeframeSummary {
  m5Flow: string;
  m5Confidence: number;
  h1Bias: string;
  h4Bias: string;
  macroBias: string;
}

export interface StrategyScoreSummary {
  strategyId: string;
  score: number;
  triggered: boolean;
  reason: string;
}

import type { AccountFinancialSnapshot } from "../execution/ledger";

export type FinancialAccountingSummary = AccountFinancialSnapshot;

export interface OpenPositionDetail {
  id: string;
  symbol: string;
  direction: string;
  strategy: string;
  size: number;
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskUSD: number;
  targetUSD: number;
  unrealizedPnLUSD: number;
  unrealizedPnLPct: number;
  unrealizedR: number;
  openedMinsAgo: number;
}

export interface BotContext {
  timestamp: string;
  symbol: string;
  chart: {
    lastPrice: number;
    recentCandles: CandleSummary[];
    technicals: TechnicalsSummary;
    multiTimeframe: MultiTimeframeSummary;
    strategyScores: StrategyScoreSummary[];
  };
  financials: FinancialAccountingSummary;
  openPositions: OpenPositionDetail[];
  recentClosedTrades: {
    id: string;
    strategy: string;
    direction: string;
    outcome: string;
    entryPrice: number;
    exitPrice: number;
    realizedPnLUSD: number;
    pnlR: number;
    durationMin: number;
    notes?: string;
  }[];
  lastSignal: {
    strategy: string;
    direction: string;
    score: number;
    flow: string;
    macroBias: string;
    rsi: number;
    atr: number;
    vwapDevPct: number;
    volumeMultiplier: number;
    entry: number;
    sl: number;
    tp: number;
  } | null;
}

// ── System prompt ───────────────────────────────────────────
const SYSTEM_PROMPT = `You are the Lead Quantitative Trading Analyst and Head Risk Accountant for an automated institutional trading bot.

The bot trades BTC/USDT perpetual futures on Bybit using 5 core quantitative strategies:
1. TREND_PULLBACK_EMA — EMA confluence pullback in trending markets
2. SR_FLIP_INVERSION — Support/Resistance flip retest
3. BB_MEAN_REVERSION — Bollinger Band overextension fade (RSI confirmed)
4. LIQUIDITY_SWEEP_REVERSAL — Stop hunt detection and reversal
5. VWAP_DEVIATION_REVERSAL — Session VWAP stretch fade

Risk management: 2R target, ATR-based stops, 1% account risk per trade, max 2 open trades.

You have full real-time access to:
1. LIVE CHART TELEMETRY: Latest OHLCV candle price action, EMAs (9, 21, 50, 200), intraday VWAP, RSI(14), ATR volatility, Bollinger Bands, and Higher Timeframe (H1/H4) trend bias.
2. DOLLAR ACCOUNTING LEDGER: Exact Starting Capital, Total Equity, Cash/Free Margin, Locked Margin, Realized & Unrealized PnL ($), Win Rate, Profit Factor, Peak Equity, and Drawdowns.
3. OPEN POSITIONS & RISK: Mark prices, floating PnL in exact dollars & R-multiples, distance to SL/TP, and duration.
4. STRATEGY SCANNER: Live scores (0-100) and rationale for every strategy on the latest candle.

Your responsibilities:
- Read and interpret the chart clearly when asked (price trends, support/resistance, momentum, candle patterns, VWAP stretches).
- Account for every single dollar in the account with zero ambiguity.
- Explain why trades opened, closed, or why the scanner is waiting for specific conditions.
- Give crisp, highly professional, direct answers. Keep responses concise (under 250 words) and plain text (no markdown symbols like asterisks or hashtags since this is sent via Telegram).`;

// ── Helper to format complete telemetry into prompt text ─────
function formatContextForPrompt(ctx: BotContext): string {
  const c = ctx.chart;
  const f = ctx.financials;

  const candlesText = c.recentCandles && c.recentCandles.length > 0
    ? c.recentCandles.map((k) => `[${k.time}] O:${k.open} H:${k.high} L:${k.low} C:${k.close} (${k.type} ${k.changePct >= 0 ? "+" : ""}${k.changePct}%) Vol:${k.volume}`).join("\n")
    : "No recent candle history available.";

  const strategyScoresText = c.strategyScores && c.strategyScores.length > 0
    ? c.strategyScores.map((s) => `• ${s.strategyId}: ${s.score}/100 [${s.triggered ? "TRIGGERED" : "WAITING"}] — ${s.reason}`).join("\n")
    : "No scanner data.";

  const openPosText = ctx.openPositions && ctx.openPositions.length > 0
    ? ctx.openPositions.map((p) => `• ${p.direction} ${p.symbol} @ $${p.entryPrice} | Mark: $${p.currentPrice} | SL: $${p.stopLoss} | TP: $${p.takeProfit} | Floating PnL: ${p.unrealizedPnLUSD >= 0 ? "+" : ""}$${p.unrealizedPnLUSD} (${p.unrealizedR >= 0 ? "+" : ""}${p.unrealizedR}R / ${p.unrealizedPnLPct}%) | Risk: $${p.riskUSD} | Target: $${p.targetUSD} | Age: ${p.openedMinsAgo}m | Strat: ${p.strategy}`).join("\n")
    : "None (0 open positions).";

  const recentTradesText = ctx.recentClosedTrades && ctx.recentClosedTrades.length > 0
    ? ctx.recentClosedTrades.map((t) => `• ${t.strategy} ${t.direction} → ${t.outcome} | Net PnL: ${t.realizedPnLUSD >= 0 ? "+" : ""}$${t.realizedPnLUSD} (${t.pnlR}R) | Exit: $${t.exitPrice} | Duration: ${t.durationMin}m`).join("\n")
    : "No closed trades recorded yet.";

  return `
=== LIVE MARKET & CHART TELEMETRY ===
Symbol: ${ctx.symbol} | Current Price: $${c.lastPrice}
Multi-Timeframe Structure: M5 Flow=${c.multiTimeframe.m5Flow} (Conf: ${(c.multiTimeframe.m5Confidence * 100).toFixed(0)}%) | H1 Bias=${c.multiTimeframe.h1Bias} | H4 Macro=${c.multiTimeframe.macroBias}
Indicators (M5):
  • EMAs: 9=$${c.technicals.ema9} | 21=$${c.technicals.ema21} | 50=$${c.technicals.ema50} | 200=$${c.technicals.ema200} [${c.technicals.emaAlignment}]
  • VWAP: $${c.technicals.vwap} (Deviation: ${c.technicals.vwapDeviationPct}%)
  • RSI(14): ${c.technicals.rsi14} [${c.technicals.rsiStatus}] | ATR(14): $${c.technicals.atr14} | Vol Mult: ${c.technicals.volumeMultiplier}x
  • Bollinger Bands: Upper=$${c.technicals.bollingerUpper} | Mid=$${c.technicals.bollingerMiddle} | Lower=$${c.technicals.bollingerLower} | %B=${c.technicals.bollingerPercentB} | Bandwidth=${c.technicals.bollingerBandwidthPct}%

Recent M5 Price Action (Last ${c.recentCandles.length} bars):
${candlesText}

Strategy Scanner Status:
${strategyScoresText}

=== COMPLETE DOLLAR FINANCIAL LEDGER ===
Starting Capital: $${f.startingBalanceUSD} | Total Equity: $${f.totalEquityUSD} | Cash / Free Margin: $${f.cashBalanceUSD}
Locked Margin in Positions: $${f.lockedMarginUSD}
Realized PnL: ${f.totalRealizedPnLUSD >= 0 ? "+" : ""}$${f.totalRealizedPnLUSD} | Floating Unrealized PnL: ${f.totalUnrealizedPnLUSD >= 0 ? "+" : ""}$${f.totalUnrealizedPnLUSD}
Performance: WinRate=${f.winRatePct}% (${f.winningTrades}W / ${f.losingTrades}L / ${f.breakevenTrades}BE) | Profit Factor=${f.profitFactor} | Expectancy: $${f.expectancyUSD}/trade
Risk & Drawdown: Peak Equity=$${f.peakEquityUSD} | Current Drawdown=$${f.currentDrawdownUSD} (${f.currentDrawdownPct}%) | Max DD=${f.maxDrawdownPct}%

=== OPEN POSITIONS (${ctx.openPositions.length}) ===
${openPosText}

=== RECENT CLOSED TRADES ===
${recentTradesText}
`.trim();
}

// ── Message type ────────────────────────────────────────────
interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ── Single HTTP attempt (SSE streaming) ─────────────────────
function nimAttempt(messages: ChatMessage[], apiKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: 2048,
      temperature: 0.7,
      stream: true,
    });

    const options = {
      hostname: NIM_HOST,
      path: NIM_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "text/event-stream",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      // Treat server-side overload codes as retryable errors
      if (res.statusCode === 529 || res.statusCode === 503 || res.statusCode === 502) {
        res.resume(); // drain response body
        reject(new Error(`NIM_OVERLOAD:${res.statusCode}`));
        return;
      }

      let fullText = "";
      let rawBuffer = "";

      res.on("data", (chunk: Buffer) => {
        rawBuffer += chunk.toString("utf8");
        const lines = rawBuffer.split("\n");
        rawBuffer = lines.pop() ?? ""; // keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;
          if (!trimmed.startsWith("data: ")) continue;

          try {
            const json = JSON.parse(trimmed.slice(6));
            const delta = json?.choices?.[0]?.delta?.content ?? "";
            fullText += delta;
          } catch {
            // skip malformed chunks
          }
        }
      });

      res.on("end", () => {
        const result = fullText.trim();
        console.log(`[Analyst] Response received (${result.length} chars)`);
        resolve(result);
      });

      res.on("error", reject);
    });

    req.on("error", reject);

    // 120 second timeout
    req.setTimeout(120000, () => {
      req.destroy();
      reject(new Error("NIM request timed out after 120s"));
    });

    req.write(body);
    req.end();
  });
}

// ── API key pool (rotation on rate-limit) ────────────────────
// Loads keys from NVIDIA_API_KEY_1, NVIDIA_API_KEY_2, … NVIDIA_API_KEY_N.
// Falls back to the legacy NVIDIA_API_KEY if numbered keys are absent.
function loadApiKeys(): string[] {
  const keys: string[] = [];
  let i = 1;
  while (true) {
    const k = process.env[`NVIDIA_API_KEY_${i}`];
    if (!k) break;
    keys.push(k);
    i++;
  }
  // Fall back to legacy single-key env var
  if (keys.length === 0) {
    const legacy = process.env.NVIDIA_API_KEY ?? "";
    if (legacy) keys.push(legacy);
  }
  return keys;
}

// ── HTTP request with key rotation + exponential-backoff retry ─
// On overload/rate-limit: rotates to the next key before retrying.
// Total attempts = MAX_RETRIES_PER_KEY × number of keys.
const MAX_RETRIES_PER_KEY = 2;
const BASE_DELAY_MS = 5_000;

async function nimRequest(
  messages: ChatMessage[],
  keys: string[],
  startKeyIndex: number = 0
): Promise<{ text: string; keyIndex: number }> {
  if (keys.length === 0) throw new Error("No NVIDIA API keys configured");

  let lastErr: Error = new Error("Unknown NIM error");
  let keyIndex = startKeyIndex % keys.length;

  const totalAttempts = MAX_RETRIES_PER_KEY * keys.length;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    const currentKey = keys[keyIndex];
    try {
      const text = await nimAttempt(messages, currentKey);
      return { text, keyIndex };
    } catch (err: any) {
      lastErr = err;
      const isOverload =
        String(err?.message ?? "").startsWith("NIM_OVERLOAD") ||
        String(err?.message ?? "").toLowerCase().includes("overload") ||
        String(err?.message ?? "").toLowerCase().includes("too many") ||
        String(err?.message ?? "").toLowerCase().includes("rate limit");

      if (!isOverload) throw err; // non-retryable error — fail immediately

      // Rotate to next key
      const nextKeyIndex = (keyIndex + 1) % keys.length;
      console.warn(
        `[Analyst] Rate-limit/overload on key ${keyIndex + 1}/${keys.length} (attempt ${attempt + 1}/${totalAttempts}). ` +
        `Rotating to key ${nextKeyIndex + 1}...`
      );
      keyIndex = nextKeyIndex;

      const delayMs = BASE_DELAY_MS * Math.pow(2, Math.floor(attempt / keys.length)); // 5s, 10s, 20s per round
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw lastErr;
}

// ── Analyst class ───────────────────────────────────────────
export class GeminiAnalyst {
  private apiKeys: string[];
  private currentKeyIndex: number = 0;
  private enabled: boolean;
  private chatHistory: ChatMessage[] = [];

  constructor() {
    this.apiKeys = loadApiKeys();
    this.enabled = this.apiKeys.length > 0;

    if (!this.enabled) {
      console.warn("[Analyst] No NVIDIA API keys found — analyst disabled. Add NVIDIA_API_KEY_1 (or NVIDIA_API_KEY) to env.");
    } else {
      console.log(`[Analyst] Kimi K3 via NVIDIA NIM initialised — ${this.apiKeys.length} key(s) in rotation pool`);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ──────────────────────────────────────────────────────────
  // Proactive: trade opened
  // ──────────────────────────────────────────────────────────

  async analyzeTradeOpen(trade: any, signal: any, context: BotContext): Promise<string | null> {
    if (!this.enabled) return null;

    const formattedContext = formatContextForPrompt(context);

    return await this.generate([
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `New trade opened on ${context.symbol}. Analyze the setup quality, chart alignment, and dollar risk.

${formattedContext}

Trade Details:
Strategy: ${trade.strategyId}
Direction: ${trade.direction} @ $${trade.entryPrice}
Stop Loss: $${trade.stopLoss} | Take Profit: $${trade.takeProfit}
Position Size: ${trade.size}
Flow: ${signal.flow.flow} | Macro Bias: ${signal.flow.macroBias}
RSI: ${signal.indicators.rsi14.toFixed(1)} | VWAP Dev: ${signal.indicators.vwap.deviationPct.toFixed(3)}% | Vol Multiplier: ${signal.indicators.volumeMultiplier.toFixed(2)}x`,
      },
    ]);
  }

  // ──────────────────────────────────────────────────────────
  // Proactive: trade closed
  // ──────────────────────────────────────────────────────────

  async analyzeTradeClose(trade: any, context: BotContext): Promise<string | null> {
    if (!this.enabled) return null;

    const formattedContext = formatContextForPrompt(context);

    return await this.generate([
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Trade closed on ${context.symbol}. Review outcome, execution, and dollar impact on the ledger.

${formattedContext}

Closed Trade Details:
Strategy: ${trade.strategyId} | Direction: ${trade.direction} → Outcome: ${trade.outcome}
Entry: $${trade.entryPrice} | Exit: $${trade.exitPrice}
Net PnL: $${(trade.pnlRaw ?? 0).toFixed(2)} (${(trade.pnlR ?? 0).toFixed(2)}R)
Duration: ${Math.round((trade.durationMs ?? 0) / 60000)} minutes`,
      },
    ]);
  }

  // ──────────────────────────────────────────────────────────
  // Proactive: daily summary
  // ──────────────────────────────────────────────────────────

  async analyzeDailySummary(context: BotContext): Promise<string | null> {
    if (!this.enabled) return null;

    const formattedContext = formatContextForPrompt(context);

    return await this.generate([
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `End of day comprehensive review.

${formattedContext}

Summarize today's performance, audit every dollar gained/lost, evaluate current market structure, assess open positions, and provide one key recommendation. Keep under 180 words.`,
      },
    ]);
  }

  // ──────────────────────────────────────────────────────────
  // Chat
  // ──────────────────────────────────────────────────────────

  async chat(userMessage: string, context: BotContext): Promise<string> {
    if (!this.enabled) return "AI analyst is not configured. Add NVIDIA_API_KEY to Railway variables.";

    const formattedContext = formatContextForPrompt(context);

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...this.chatHistory,
      {
        role: "user",
        content: `${formattedContext}\n\nUSER QUESTION: ${userMessage}`,
      },
    ];

    try {
      const { text: reply, keyIndex } = await nimRequest(messages, this.apiKeys, this.currentKeyIndex);
      this.currentKeyIndex = keyIndex; // stick with the key that worked

      this.chatHistory.push({ role: "user", content: userMessage });
      this.chatHistory.push({ role: "assistant", content: reply });
      if (this.chatHistory.length > 20) this.chatHistory = this.chatHistory.slice(-20);

      return reply || "No response from AI.";
    } catch (err: any) {
      console.error("[Analyst] Chat error:", err.message);
      this.chatHistory = [];
      return `AI error: ${err.message}`;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Private: generate
  // ──────────────────────────────────────────────────────────

  private async generate(messages: ChatMessage[]): Promise<string | null> {
    try {
      const { text, keyIndex } = await nimRequest(messages, this.apiKeys, this.currentKeyIndex);
      this.currentKeyIndex = keyIndex; // remember which key succeeded
      return text.length > 10 ? text : null;
    } catch (err: any) {
      console.error("[Analyst] Generation error:", err.message);
      return null;
    }
  }
}
