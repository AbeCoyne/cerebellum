import type { Request, Response, NextFunction } from 'express';
import { cfg } from '../config.js';

export function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  // Requests from localhost never need a Bearer token — the daemon only binds
  // to 127.0.0.1 so this is safe. CORTEX desktop uses this for the queue review UI.
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
    next();
    return;
  }

  const header = req.headers.authorization;
  if (!cfg.http.apiKey) {
    res.status(503).json({ error: 'Server not configured: CEREBELLUM_API_KEY not set' });
    return;
  }
  if (!header?.startsWith('Bearer ') || header.slice(7) !== cfg.http.apiKey) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
