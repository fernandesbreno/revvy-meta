import { agoraBr } from './store.js';
import { normalize } from './config.js';

/**
 * Quando a equipe manda a mensagem de confirmação da sessão ("Passando para confirmar sua sessão do dia ..."),
 * o cliente passa a ser da Recepção: o card dele vai para a etapa Recepção e ganha a etiqueta de cliente.
 * A mensagem chega pelo webhook do Revvy (enviada pela tela do Revvy) ou pelo eco da Meta (enviada pelo celular);
 * as duas trazem o mesmo wamid, então a mesma mensagem não é tratada duas vezes.
 */

/** O texto é uma confirmação de sessão? Data, horário e emojis mudam; a frase-chave não. */
export function isConfirmation(text, frases) {
  const t = normalize(text);
  return Boolean(t) && frases.some((f) => t.includes(f));
}

/** Textos (e legendas) que a equipe mandou pelo celular, dos ecos smb_message_echoes. */
export function parseEchoTexts(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      for (const e of [...(v.message_echoes || []), ...(change.field === 'smb_message_echoes' ? v.messages || [] : [])]) {
        const text = e.text?.body || e.image?.caption || e.video?.caption || e.document?.caption;
        if (!text) continue;
        out.push({ messageId: e.id ? String(e.id) : null, phone: String(e.to || '').replace(/\D/g, ''), contactId: null, text: String(text) });
      }
    }
  }
  return out;
}

/** Mensagem do webhook do Revvy: só as que a empresa mandou. */
export function parseRevvyText(body) {
  const d = body?.data || body || {};
  const msg = d.message || {};
  if (msg.from_me !== true && msg.from_me !== 'true' && !/sent|enviad/i.test(String(body?.event || ''))) return null;
  if (!msg.text) return null;
  return {
    messageId: String(msg.wa_message_id || msg.id || ''),
    phone: String(d.contact?.phone || '').replace(/\D/g, ''),
    contactId: d.contact?.id ? String(d.contact.id) : null,
    text: String(msg.text),
  };
}

export class ConfirmacaoRecepcao {
  constructor({ cfg, store, revvy, logger = console }) {
    Object.assign(this, { cfg: cfg.recepcao, store, revvy, logger });
    this.frases = this.cfg.frases.map(normalize).filter(Boolean);
    this.timers = new Set();
  }

  get ligado() { return Boolean(this.cfg.ligado && this.frases.length); }

  get st() { return (this.store.state.recepcao ||= { feitos: {}, log: [] }); }

  log(entry) {
    const st = this.st;
    st.log.unshift({ em: agoraBr(), ...entry });
    st.log.length = Math.min(st.log.length, 100);
    this.store.save();
  }

  /** Recebe uma mensagem da equipe; se for confirmação de sessão, agenda a mudança de etapa. */
  handle(m, delayMs = 0) {
    if (!m || !this.ligado || !isConfirmation(m.text, this.frases)) return false;
    const key = m.messageId || `${m.phone}:${normalize(m.text).slice(0, 60)}`;
    if (this.st.feitos[key]) return false;
    this.st.feitos[key] = Math.floor(Date.now() / 1000);
    this.store.save();
    this.schedule({ key, m, attempts: 0 }, delayMs);
    return true;
  }

  schedule(job, delayMs) {
    const t = setTimeout(() => { this.timers.delete(t); this.run(job); }, delayMs);
    this.timers.add(t);
  }

  async run(job) {
    const { m } = job;
    try {
      const contactId = m.contactId || (await this.contactByPhone(m.phone));
      const { column, pipelineId } = await this.recepcao();
      const r = await this.revvy.request(`/api/v1/deals?contact_id=${encodeURIComponent(contactId)}&limit=50`);
      const list = (r.data || r.deals || []).filter((d) => (d.contact_id ?? d.contact?.id ?? contactId) === contactId);
      const colOf = (d) => d.column_id ?? d.column?.id;
      let resultado;
      if (list.some((d) => colOf(d) === column.id)) {
        resultado = 'já estava na Recepção';
      } else if (list.length) {
        list.sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
        await this.revvy.request('/api/v1/deals/move', 0, {
          method: 'POST', body: { deal_id: list[0].id, column_id: column.id }, headers: { 'Idempotency-Key': `recepcao-${job.key}`.slice(0, 128) },
        });
        resultado = `card movido de "${list[0].column?.name || colOf(list[0]) || '?'}" para Recepção`;
      } else {
        await this.revvy.createDeal({ contact: { phone: m.phone }, kanban: { sector_id: pipelineId, column_id: column.id } }, `recepcao-${job.key}`.slice(0, 128));
        resultado = 'card criado na Recepção';
      }
      const tagId = await this.tagId();
      if (tagId) await this.revvy.request('/api/v1/contacts/tags', 0, { method: 'POST', body: { contact_id: contactId, tag_ids: [tagId] } });
      this.log({ resultado, contato: contactId, telefone: m.phone });
    } catch (err) {
      job.attempts += 1;
      if (job.attempts < 3) {
        this.log({ resultado: 'nova tentativa', telefone: m.phone, detalhe: err.message });
        this.schedule(job, job.attempts * 60_000);
      } else {
        this.log({ resultado: 'erro', telefone: m.phone, detalhe: err.message });
        this.logger.error(`[recepção] desistiu do contato ${m.phone}: ${err.message}`);
      }
    }
  }

  async contactByPhone(phone) {
    const tail = String(phone).slice(-8);
    if (tail.length < 8) throw new Error('mensagem sem telefone do cliente');
    const found = await this.revvy.request(`/api/v1/contacts?search=${encodeURIComponent(tail)}&limit=10`);
    const c = (found.data || []).find((x) => String(x.phone || '').replace(/\D/g, '').endsWith(tail));
    if (!c) throw new Error(`contato com final ${tail} não encontrado no Revvy`);
    return c.id;
  }

  async recepcao() {
    if (!this.coluna) {
      const r = await this.revvy.request('/api/v1/columns');
      const alvo = normalize(this.cfg.coluna);
      for (const p of r.pipelines || []) {
        const column = (p.columns || []).find((c) => normalize(c.name) === alvo);
        if (column) { this.coluna = { column, pipelineId: p.id }; break; }
      }
      if (!this.coluna) throw new Error(`etapa "${this.cfg.coluna}" não existe no Revvy`);
    }
    return this.coluna;
  }

  async tagId() {
    if (!this.cfg.etiqueta) return null;
    if (this.tag === undefined) {
      const r = await this.revvy.request('/api/v1/tags');
      this.tag = (r.data || r.tags || []).find((t) => normalize(t.name) === normalize(this.cfg.etiqueta))?.id || null;
      if (!this.tag) this.logger.warn(`[recepção] etiqueta "${this.cfg.etiqueta}" não existe no Revvy; o card muda de etapa sem etiqueta`);
    }
    return this.tag;
  }

  stop() { for (const t of this.timers) clearTimeout(t); this.timers.clear(); }
}
