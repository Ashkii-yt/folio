import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST, PORT, PUBLIC_DIR, DATA_DIR } from './config.js';
import { api } from './routes/api.js';
import { HttpError, log, redact } from './util.js';
import { closeAll } from './accounts.js';
import { closeShared } from './shared.js';
import { auth, requireUser } from './routes/auth.js';
import { VERSION } from './config.js';
import { serverIdentity } from './identity.js';
import { startSyncService } from './sync/service.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function createApp({ dev = !!process.env.FOLIO_DEV } = {}) {
  const app = express();
  app.disable('x-powered-by');

  const extraHosts = (process.env.FOLIO_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  // Guard against DNS-rebinding and cross-site requests: this server holds API keys.
  app.use((req, res, next) => {
    const hostHeader = String(req.headers.host || '').toLowerCase();
    const hostname = hostHeader.replace(/:\d+$/, '');
    if (!LOOPBACK.has(hostname) && !extraHosts.includes(hostname)) {
      return res.status(421).json({ error: { message: 'Unrecognised host. Open Folio at http://localhost.', code: 'bad_host' } });
    }
    const origin = req.headers.origin;
    if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      let ok = false;
      try {
        const o = new URL(origin);
        ok = o.host.toLowerCase() === hostHeader || (dev && LOOPBACK.has(o.hostname));
      } catch {
        ok = false;
      }
      if (!ok) return res.status(403).json({ error: { message: 'Cross-site request blocked.', code: 'bad_origin' } });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use('/api/data/import', express.json({ limit: '300mb' }));
  app.use(express.json({ limit: '4mb' }));
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/health', (req, res) => res.json({ ok: true, version: VERSION }));
  app.use('/api/auth', auth);
  app.use('/api', requireUser, api);

  if (fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
    app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
  } else {
    app.get('/', (req, res) =>
      res.type('text').send('Folio API is running. The web UI has not been built yet: run `npm run build`, or use `npm run dev`.')
    );
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { message: err.message, code: err.code, hint: err.hint } });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { message: 'The request body is not valid JSON.', code: 'bad_json' } });
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: { message: 'That is too large to send.', code: 'too_large' } });
    }
    if (res.headersSent) return res.end();
    log('unhandled error:', redact(err?.stack || String(err)));
    res.status(500).json({ error: { message: 'Something went wrong on the server.', code: 'internal' } });
  });

  return app;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (!LOOPBACK.has(HOST) && process.env.FOLIO_ALLOW_NETWORK !== '1') {
    console.error(
      `Refusing to listen on ${HOST}. By default Folio only accepts connections from this computer.\n` +
        'To serve other people, set FOLIO_ALLOW_NETWORK=1 and FOLIO_ALLOWED_HOSTS=<your hostname>, and put it behind HTTPS (a reverse proxy; also set FOLIO_TRUST_PROXY=1 and FOLIO_SECURE_COOKIES=1). Passwords sent over plain http can be read on the network.'
    );
    process.exit(1);
  }
  const app = createApp();
  const server = app.listen(PORT, HOST, () => {
    log(`Folio is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    log(`Data directory: ${DATA_DIR}`);
    log(`Server ID: ${serverIdentity().serverId}`);
    if (process.env.FOLIO_SYNC_SERVICE !== '0') {
      startSyncService({ log }).then((s) => { syncService = s; }).catch((e) => log(`Server-to-server sync is unavailable: ${e.message}`));
    }
  });
  let syncService = null;
  const shutdown = () => {
    syncService?.stop();
    server.close(() => {
      closeAll();
      closeShared();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
