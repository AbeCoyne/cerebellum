import express from 'express';
import { bearerAuth } from './auth.js';
import { router as apiRouter } from './routes/api.js';
import { handleMcpRequest } from './mcp.js';
import { startQueuePoller } from '../queue-poller.js';

// Origins allowed to call the local daemon.
// Covers: Vite dev server (http://localhost:5173), any localhost port,
// and the Tauri production webview (tauri://localhost).
const ALLOWED_ORIGINS = /^(https?:\/\/(localhost|127\.0\.0\.1|tauri\.localhost)(:\d+)?|tauri:\/\/localhost|https:\/\/.+)$/;

export function startServer(port: number) {
  const app = express();
  app.use(express.json());

  // ── CORS — localhost only ────────────────────────────────────────────────
  // The Tauri WebView and Vite dev server both run on localhost; external
  // origins are never allowed (daemon binds to 127.0.0.1 anyway).
  app.use((req, res, next) => {
    const origin = req.headers.origin ?? '';
    if (ALLOWED_ORIGINS.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Health check — no auth (usable by PM2 health checks and monitoring)
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), version: '0.1.0' });
  });

  // MCP endpoint — no auth (standard MCP clients cannot inject Bearer tokens)
  app.post('/mcp', handleMcpRequest);

  // REST API — bearer auth required
  app.use(bearerAuth);
  app.use('/api', apiRouter);

  // Bind to loopback only — no access from other hosts on the network
  return app.listen(port, '0.0.0.0', () => {
    console.log(`[cerebellum] HTTP daemon running on http://127.0.0.1:${port}`);
    startQueuePoller();
  });
}
