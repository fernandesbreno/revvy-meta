import http from 'node:http';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { RevvyClient, parseWebhook, verifySignature } from './revvy.js';
import { MetaClient } from './meta.js';
import { Processor } from './processor.js';
import { reconcile } from './reconcile.js';

export function createApp({ cfg, fetchImpl = fetch, logger = console }) {
  const store = new Store(cfg.dataDir);
  const revvy = new RevvyClient(cfg.revvy, { fetchImpl });
  const meta = new MetaClient(cfg.meta, { fetchImpl });
  const processor = new Processor({ cfg, store, revvy, meta, logger });

  const json = (res, status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj, null, 2));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json(res, 200, { ok: true, pendentes: store.state.pending.length, modo_teste: Boolean(cfg.meta.testEventCode) });
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      if (!cfg.adminToken || url.searchParams.get('token') !== cfg.adminToken) return json(res, 401, { erro: 'token inválido' });
      return json(res, 200, {
        pendentes: store.state.pending.map(({ dealId, columnName, attempts, lastError }) => ({ dealId, columnName, attempts, lastError })),
        enviados_total: Object.keys(store.state.sent).length,
        ultimos: store.state.log.slice(0, 50),
      });
    }

    if (req.method === 'POST' && url.pathname === '/webhooks/revvy') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        if (cfg.revvy.validateSignature) {
          const v = verifySignature({
            secret: cfg.revvy.webhookSecret,
            timestamp: req.headers['x-webhook-timestamp'],
            signature: req.headers['x-webhook-signature'],
            rawBody: raw,
          });
          if (!v.ok) {
            logger.warn(`[webhook recusado] ${v.reason}`);
            return json(res, 401, { erro: v.reason });
          }
        }
        let body;
        try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return json(res, 400, { erro: 'JSON inválido' }); }
        const parsed = parseWebhook(body);
        if (!parsed) {
          store.log({ resultado: 'ignorado', detalhe: 'webhook sem negócio', evento: String(body.event || body.type || '') });
          return json(res, 200, { ok: true, ignorado: true });
        }
        processor.enqueue({ ...parsed, origem: 'webhook' });
        return json(res, 200, { ok: true });
      });
      return;
    }

    json(res, 404, { erro: 'não encontrado' });
  });

  let reconcileTimer = null;
  const runReconcile = () => reconcile({ cfg, store, revvy, processor, logger }).catch((e) => logger.error(`[reconciliação] ${e.message}`));

  return {
    server,
    store,
    processor,
    runReconcile,
    start() {
      processor.start();
      if (cfg.reconcile.intervalMinutes > 0) {
        setTimeout(runReconcile, 60_000);
        reconcileTimer = setInterval(runReconcile, cfg.reconcile.intervalMinutes * 60_000);
      }
      return new Promise((r) => server.listen(cfg.port, () => r(server)));
    },
    stop() {
      processor.stop();
      clearInterval(reconcileTimer);
      return new Promise((r) => server.close(r));
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const app = createApp({ cfg });
  await app.start();
  console.log(`revvy-meta ouvindo na porta ${cfg.port}${cfg.meta.testEventCode ? ' (MODO TESTE)' : ''}`);
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => app.stop().then(() => process.exit(0)));
}
