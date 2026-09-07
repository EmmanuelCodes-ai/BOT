// ============================================================
// Health Check Server
// Exposes a minimal HTTP server on PORT (default 3000) so:
//   - Back4app/Railway can detect the process is alive
//   - GitHub Actions cron can ping it to prevent sleep
//   - /test-summary triggers a manual daily summary (testing only)
// ============================================================

import * as http from "http";

// Callback registered by TradingBot to trigger the daily summary on demand
let testSummaryCallback: (() => Promise<void>) | null = null;

export function registerTestSummaryCallback(cb: () => Promise<void>): void {
  testSummaryCallback = cb;
}

export function startHealthServer(port: number = 3000): void {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          uptime: Math.floor(process.uptime()),
          timestamp: new Date().toISOString(),
        })
      );
    } else if (req.url === "/test-summary") {
      // Manual trigger — fires the daily summary immediately
      // Useful for verifying Telegram formatting without waiting for midnight
      if (testSummaryCallback) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "triggered", message: "Daily summary sent to Telegram" }));
        await testSummaryCallback();
      } else {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "not_ready", message: "Bot not initialised yet" }));
      }
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(port, () => {
    console.log(`[Health] Server listening on port ${port}`);
  });

  server.unref();
}
