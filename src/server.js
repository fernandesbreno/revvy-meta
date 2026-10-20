import http from 'node:http';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { RevvyClient, parseWebhook, verifySignature } from './revvy.js';
import { MetaClient } from './meta.js';
import { Processor } from './processor.js';
import { reconcile } from './reconcile.js';
import { LeadsImporter } from './leads.js';
import { Distributor } from './distribuidor.js';
import { AudioTranscriber, isMessageWebhook, parseEchoes, verifyMetaSignature } from './audios.js';

export function createApp({ cfg, fetchImpl = fetch, logger = console }) {
  const store = new Store(cfg.dataDir);
  const revvy = new RevvyClient(cfg.revvy, { fetchImpl });
  const meta = new MetaClient(cfg.meta, { fetchImpl });
  const processor = new Processor({ cfg, store, revvy, meta, logger });
  const leads = cfg.leads.pageId ? new LeadsImporter({ cfg, store, revvy, fetchImpl, logger }) : null;
  const distributor = cfg.distribuir.atendentes.length ? new Distributor({ cfg, store, revvy, logger }) : null;
  const audios = new AudioTranscriber({ cfg, store, revvy, fetchImpl, logger });

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
        distribuicao: store.state.distribuicao ? { contagem: store.state.distribuicao.contagem, proxima: cfg.distribuir.atendentes[store.state.distribuicao.vez]?.nome } : null,
        ultimos: store.state.log.slice(0, 50),
      });
    }

    // Depois de trocar o conjunto de dados: esquece o que já foi enviado e manda de novo os últimos 7 dias
    if (req.method === 'GET' && url.pathname === '/reenviar') {
      if (!cfg.adminToken || url.searchParams.get('token') !== cfg.adminToken) return json(res, 401, { erro: 'token inválido' });
      if (url.searchParams.get('confirmar') !== 'sim') {
        return json(res, 400, { erro: 'acrescente &confirmar=sim: isso reenvia ao conjunto de dados atual tudo dos últimos 7 dias' });
      }
      const esquecidos = Object.keys(store.state.sent).length;
      store.state.sent = {};
      store.log({ resultado: 'reenvio', detalhe: `${esquecidos} envios esquecidos; reenviando os últimos 7 dias ao conjunto ${cfg.meta.datasetId}` });
      store.save();
      runReconcile();
      return json(res, 200, { ok: true, esquecidos, conjunto: cfg.meta.datasetId, detalhe: 'reenvio começou; acompanhe em /status' });
    }

    // Transcrição dos áudios da equipe: o que foi feito e os últimos webhooks de mensagem recebidos, para conferir o formato
    if (req.method === 'GET' && url.pathname === '/audios') {
      if (!cfg.adminToken || url.searchParams.get('token') !== cfg.adminToken) return json(res, 401, { erro: 'token inválido' });
      const st = audios.st;
      return json(res, 200, {
        ligado: audios.ligado,
        modelo: cfg.audios.modelo,
        transcritos_total: Object.values(st.feitos).filter((v) => typeof v === 'number').length,
        ultimos: st.log.slice(0, 50),
        ultimos_webhooks: st.amostras,
      });
    }

    // Webhook da Meta para os ecos do WhatsApp (áudios que a equipe manda pelo celular)
    if (req.method === 'GET' && url.pathname === '/webhooks/whatsapp') {
      const ok = cfg.audios.verifyToken && url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === cfg.audios.verifyToken;
      if (!ok) return json(res, 403, { erro: 'verify token inválido' });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(url.searchParams.get('hub.challenge') || '');
    }

    if (req.method === 'POST' && url.pathname === '/webhooks/whatsapp') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        if (!cfg.audios.appSecret || !verifyMetaSignature({ appSecret: cfg.audios.appSecret, signature: req.headers['x-hub-signature-256'], rawBody: raw })) {
          logger.warn('[whatsapp] webhook recusado: assinatura inválida ou META_APP_SECRET vazio');
          return json(res, 401, { erro: 'assinatura inválida' });
        }
        let body;
        try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return json(res, 400, { erro: 'JSON inválido' }); }
        const ecos = parseEchoes(body);
        for (const m of ecos) audios.handleEcho(m);
        return json(res, 200, { ok: true, audios: ecos.length });
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/webhooks/revvy') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        if (cfg.revvy.validateSignature) {
          let v;
          for (const secret of [cfg.revvy.webhookSecret, ...cfg.revvy.extraSecrets]) {
            v = verifySignature({
              secret,
              timestamp: req.headers['x-webhook-timestamp'],
              signature: req.headers['x-webhook-signature'],
              rawBody: raw,
            });
            if (v.ok) break;
          }
          if (!v.ok) {
            logger.warn(`[webhook recusado] ${v.reason}`);
            return json(res, 401, { erro: v.reason });
          }
        }
        let body;
        try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return json(res, 400, { erro: 'JSON inválido' }); }
        // mensagens vão para a transcrição de áudios; não podem cair no parseWebhook, que leria o id como negócio
        if (isMessageWebhook(body)) return json(res, 200, audios.handle(body));
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
  let distTimer = null;
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
    distributor,
    start() {
      if (distributor && cfg.distribuir.intervalSeconds > 0) {
        setTimeout(() => distributor.run(), 3_000);
        distTimer = setInterval(() => distributor.run(), cfg.distribuir.intervalSeconds * 1000);
      }
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
    audios,
    stop() {
      processor.stop();
      audios.stop();
      clearInterval(reconcileTimer);
      clearInterval(leadsTimer);
      clearInterval(distTimer);
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
  console.log(cfg.distribuir.atendentes.length
    ? `[distribuição] rodízio entre ${cfg.distribuir.atendentes.map((a) => a.nome).join(', ')} para os negócios novos em "${cfg.distribuir.column}" (a cada ${cfg.distribuir.intervalSeconds} s, horário: ${cfg.distribuir.horarioTexto})`
    : '[distribuição] desligada (preencha DISTRIBUIR_ATENDENTES)');
  console.log(cfg.audios.ligado && cfg.audios.apiKey
    ? `[áudios] transcrevendo os áudios da equipe com ${cfg.audios.modelo} e gravando como nota da conversa`
    : '[áudios] transcrição desligada (TRANSCREVER_AUDIOS_EQUIPE=true e OPENAI_API_KEY)');
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => app.stop().then(() => process.exit(0)));
}
