import { MESSAGING_ROUTES, buildEvent, detectRoute, findStage } from './meta.js';

// Etapa com "uma_vez_por_contato": o evento sai só no primeiro card do contato que chegar nela
// (um contato que volta e abre outro card não conta como lead de novo)
function contactKey(stage, contact, event) {
  const id = contact?.id || contact?.phone;
  return stage.uma_vez_por_contato && id ? `contato:${id}:${event.event_name}` : null;
}

const RETRY_DELAYS_S = [60, 300, 900, 3600, 3 * 3600, 6 * 3600]; // depois disso desiste

/**
 * Processa um trabalho { id, dealId, columnName, forcedStage, eventTime, lossReason }:
 * busca negócio e contato, escolhe a rota, monta os eventos (incluindo etapas puladas) e envia.
 */
export class Processor {
  constructor({ cfg, store, revvy, meta, logger = console }) {
    Object.assign(this, { cfg, store, revvy, meta, logger });
    this.running = false;
    this.timer = null;
  }

  enqueue(job) {
    this.store.addPending({ ...job, id: job.id || `${job.dealId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, attempts: 0, nextAt: 0 });
    this.kick();
  }

  kick() {
    if (!this.running) setImmediate(() => this.drain());
  }

  start() {
    this.timer = setInterval(() => this.kick(), 30_000);
    this.kick();
  }

  stop() { clearInterval(this.timer); }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      for (const job of [...this.store.state.pending]) {
        if (job.nextAt > now) continue;
        try {
          const result = await this.process(job);
          this.store.removePending(job.id);
          this.store.log({ negocio: job.dealId, ...result });
          if (result.resultado === 'enviado') this.logger.log(`[enviado] negócio ${job.dealId}: ${result.etapa} → ${result.eventos.join(', ')} (rota ${result.rota}${result.teste ? ', teste' : ''})`);
        } catch (err) {
          job.attempts += 1;
          const delay = RETRY_DELAYS_S[job.attempts - 1];
          if (err.permanent || delay === undefined) {
            this.store.removePending(job.id);
            this.store.log({ negocio: job.dealId, resultado: 'erro', detalhe: err.message });
            this.logger.error(`[desistiu] negócio ${job.dealId}: ${err.message}`);
          } else {
            job.nextAt = Date.now() + delay * 1000;
            job.lastError = err.message;
            this.store.updatePending(job);
            this.logger.warn(`[nova tentativa em ${delay}s] negócio ${job.dealId}: ${err.message}`);
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  async process(job) {
    const deal = await this.revvy.getDeal(job.dealId);
    if (!deal.id) deal.id = job.dealId;

    const stageName = job.forcedStage || job.columnName || deal.column?.name || deal.column_name;
    const stage = stageName && findStage(this.cfg, stageName);
    if (!stage) return { resultado: 'ignorado', detalhe: `coluna "${stageName ?? '?'}" não está em etapas.json` };

    let contact = { ...(deal.contact || {}) };
    if (contact.id) {
      try {
        contact = { ...contact, ...(await this.revvy.getContact(contact.id)) };
      } catch (err) {
        this.logger.warn(`contato ${contact.id} indisponível, usando dados do negócio: ${err.message}`);
      }
    }
    let routeInfo = detectRoute(contact, this.cfg);
    // Etapa com nome próprio que a Meta não aceita no formato de mensagens: vai pelo telefone
    if (stage.pelo_telefone && MESSAGING_ROUTES.includes(routeInfo.route)) routeInfo = { route: 'site' };
    try {
      return await this.sendFor(job, deal, contact, stage, routeInfo);
    } catch (err) {
      // Se a Meta recusar o formato de mensagens do WhatsApp (permissão, conta), manda pelo telefone
      if (!(err.permanent && routeInfo.route === 'whatsapp')) throw err;
      this.logger.warn(`[whatsapp] Meta recusou pelo ctwa_clid, enviando pelo telefone: ${err.message}`);
      const r = await this.sendFor(job, deal, contact, stage, { route: 'site' });
      return { ...r, detalhe: `ctwa_clid recusado: ${err.message.slice(0, 200)}` };
    }
  }

  async sendFor(job, deal, contact, stage, routeInfo) {
    // Etapas a enviar: as do funil que ficaram para trás (se o card pulou) + a atual
    const stages = [];
    if (stage.funil && this.cfg.fillSkippedStages) {
      for (const s of this.cfg.stages) {
        if (s.funil && s.ordem < stage.ordem) stages.push(s);
      }
    }
    stages.push(stage);

    const events = [];
    const skipped = [];
    const contactKeys = [];
    const base = Number(job.eventTime) || Math.floor(Date.now() / 1000);
    stages.forEach((s, i) => {
      const isCurrent = s === stage;
      const t = isCurrent ? base : base - (stages.length - 1 - i); // etapas puladas ficam 1s antes, em ordem
      const r = buildEvent({ cfg: this.cfg, deal, contact, stage: s, eventTime: t, routeInfo, lossReason: job.lossReason });
      if (r.skip) { if (isCurrent) skipped.push(r.skip); return; }
      if (this.store.wasSent(r.event.event_id)) { if (isCurrent) skipped.push('etapa já enviada antes'); return; }
      const ck = contactKey(s, contact, r.event);
      // contactKeys: o mesmo evento em mais de uma etapa do lote (etapas puladas) sai uma vez só
      if (ck && (this.store.wasSent(ck) || contactKeys.includes(ck))) { if (isCurrent) skipped.push(`${r.event.event_name} já enviado antes para este contato`); return; }
      events.push(r.event);
      if (ck) contactKeys.push(ck);
    });

    const test = Boolean(this.cfg.meta.testEventCode);
    if (!events.length) {
      // Marca a etapa como tratada para a reconciliação não reprocessar o mesmo card a cada rodada
      this.store.markSent(`${deal.id}:${stage.key.replace(/\s+/g, '_')}`, { test });
      this.store.save();
      return { resultado: 'ignorado', rota: routeInfo.route, etapa: stage.coluna, detalhe: skipped.join('; ') || 'nada a enviar' };
    }

    const resp = await this.meta.send(events, { route: routeInfo.route });
    for (const e of events) this.store.markSent(e.event_id, { test });
    for (const k of contactKeys) this.store.markSent(k, { test });
    this.store.save();
    return {
      resultado: 'enviado',
      rota: routeInfo.route,
      etapa: stage.coluna,
      eventos: events.map((e) => e.event_name),
      teste: Boolean(this.cfg.meta.testEventCode),
      fbtrace_id: resp.fbtrace_id,
    };
  }
}
