// ============================================================
// Health Check Server
// Exposes a minimal HTTP server on PORT (default 3000) so:
//   - Back4app/Railway can detect the process is alive
//   - GitHub Actions cron can ping it to prevent sleep
// ============================================================

import * as http from "http";

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
