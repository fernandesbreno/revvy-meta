import http from 'node:http';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { RevvyClient, parseWebhook, verifySignature } from './revvy.js';
import { MetaClient } from './meta.js';
import { Processor } from './processor.js';
import { reconcile } from './reconcile.js';
import { LeadsImporter } from './leads.js';

export function createApp({ cfg, fetchImpl = fetch, logger = console }) {
  const store = new Store(cfg.dataDir);
  const revvy = new RevvyClient(cfg.revvy, { fetchImpl });
  const meta = new MetaClient(cfg.meta, { fetchImpl });
  const processor = new Processor({ cfg, store, revvy, meta, logger });
  const leads = cfg.leads.pageId ? new LeadsImporter({ cfg, store, revvy, fetchImpl, logger }) : null;

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
        leads_formulario_importados: Object.keys(store.state.leads.importados).length,
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
  let leadsTimer = null;
  let reconciling = false;
  const runReconcile = async () => {
    if (reconciling) return; // a rodada anterior ainda não terminou
    reconciling = true;
    try {
      await reconcile({ cfg, store, revvy, processor, logger });
    } catch (e) {
      logger.error(`[reconciliação] ${e.message}`);
    } finally {
      reconciling = false;
    }
  };

  return {
    server,
    store,
    processor,
    runReconcile,
    leads,
    start() {
      processor.start();
      if (leads && cfg.leads.intervalMinutes > 0) {
        setTimeout(() => leads.run(), 5_000);
        leadsTimer = setInterval(() => leads.run(), cfg.leads.intervalMinutes * 60_000);
      }
      if (cfg.reconcile.intervalMinutes > 0) {
        setTimeout(runReconcile, 60_000);
        reconcileTimer = setInterval(runReconcile, cfg.reconcile.intervalMinutes * 60_000);
      }
      return new Promise((r) => server.listen(cfg.port, () => r(server)));
    },
    stop() {
      processor.stop();
      clearInterval(reconcileTimer);
      clearInterval(leadsTimer);
      return new Promise((r) => server.close(r));
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  if (cfg.meta.igAccountId && !cfg.meta.igDatasetId) {
    try {
      cfg.meta.igDatasetId = await new MetaClient(cfg.meta).instagramDataset();
      console.log(`[instagram] usando o conjunto de dados ${cfg.meta.igDatasetId}, ligado à conta do Instagram`);
    } catch (err) {
      cfg.meta.igAccountId = ''; // sem o conjunto do Instagram a Meta recusa todos os eventos do Direct: pula em vez de errar
      console.error(`[instagram] envio do Direct desligado: não consegui obter o conjunto de dados do Instagram (o token precisa da permissão instagram_manage_events): ${err.message}`);
    }
  }
  const app = createApp({ cfg });
  await app.start();
  console.log(`revvy-meta ouvindo na porta ${cfg.port}${cfg.meta.testEventCode ? ' (MODO TESTE)' : ''}`);
  console.log(cfg.leads.pageId
    ? `[formulário] trazendo leads dos formulários da página ${cfg.leads.pageId} para "${cfg.leads.column}" a cada ${cfg.leads.intervalMinutes} min`
    : '[formulário] importação de leads de formulário desligada (preencha LEADS_PAGE_ID)');
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => app.stop().then(() => process.exit(0)));
}
