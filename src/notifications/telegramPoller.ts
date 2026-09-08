// ============================================================
// Telegram Message Poller
//
// Polls the Telegram Bot API for new messages from the user
// and routes them to the Gemini analyst for a reply.
//
// Uses long-polling (getUpdates) — no webhook needed.
// Runs in background without blocking the main bot loop.
// ============================================================

import * as https from "https";

const TELEGRAM_API = "https://api.telegram.org";
const POLL_TIMEOUT = 30; // seconds — Telegram long-poll window

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name: string };
    chat: { id: number };
    text?: string;
    date: number;
  };
}

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result: TelegramUpdate[];
}

// ── Low-level HTTP helpers ─────────────────────────────────

function httpsGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

function httpsPost(url: string, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      res.resume(); // drain
      resolve();
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Poller class ───────────────────────────────────────────

export type MessageHandler = (
  chatId: number,
  text: string,
  fromName: string
) => Promise<void>;

export type CommandHandler = (
  chatId: number,
  command: string,
  fromName: string
) => Promise<void>;

export class TelegramPoller {
  private token: string;
  private allowedChatId: number;
  private lastUpdateId: number = 0;
  private running: boolean = false;
  private onMessage: MessageHandler | null = null;
  private onCommand: CommandHandler | null = null;

  constructor(token: string, allowedChatId: string) {
    this.token = token;
    this.allowedChatId = parseInt(allowedChatId, 10);
  }

  setMessageHandler(handler: MessageHandler): void {
    this.onMessage = handler;
  }

  setCommandHandler(handler: CommandHandler): void {
    this.onCommand = handler;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    console.log("[TelegramPoller] Started — listening for messages");
    this.poll();
  }

  stop(): void {
    this.running = false;
  }

  // ──────────────────────────────────────────────────────────
  // Private: long-poll loop
  // ──────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.getUpdates();

        for (const update of updates) {
          this.lastUpdateId = update.update_id;

          const msg = update.message;
          if (!msg?.text) continue;

          // Only accept messages from the configured chat ID
          if (msg.chat.id !== this.allowedChatId) {
            console.warn(
              `[TelegramPoller] Ignoring message from unknown chat ${msg.chat.id}`
            );
            continue;
          }

          const fromName = msg.from?.first_name ?? "User";
          console.log(
            `[TelegramPoller] Message from ${fromName}: ${msg.text}`
          );

          // Route slash commands separately from AI chat
          if (msg.text.startsWith("/") && this.onCommand) {
            this.onCommand(msg.chat.id, msg.text.trim(), fromName).catch((err) =>
              console.error("[TelegramPoller] Command error:", err)
            );
          } else if (this.onMessage) {
            // Don't await — handle async in background so poll continues
            this.onMessage(msg.chat.id, msg.text, fromName).catch((err) =>
              console.error("[TelegramPoller] Handler error:", err)
            );
          }
        }
      } catch (err) {
        console.error("[TelegramPoller] Poll error:", err);
        // Back off on error before retrying
        await sleep(5000);
      }
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const url =
      `${TELEGRAM_API}/bot${this.token}/getUpdates` +
      `?timeout=${POLL_TIMEOUT}` +
      `&offset=${this.lastUpdateId + 1}` +
      `&allowed_updates=["message"]`;

    const raw = await httpsGet(url);
    const parsed: TelegramGetUpdatesResponse = JSON.parse(raw);

    if (!parsed.ok) return [];
    return parsed.result ?? [];
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    const url = `${TELEGRAM_API}/bot${this.token}/sendMessage`;
    const body = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    });

    await httpsPost(url, body);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
