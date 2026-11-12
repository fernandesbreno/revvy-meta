import { agoraBr } from './store.js';
import { normalize } from './config.js';
import { echoMessages } from './audios.js';
export { parseFrasesEtapas } from './frases-etapas.js';

/**
 * Mensagem da equipe → etapa do card. Cada regra tem frases-chave e a etapa de destino.
 * Regra antiga (CONFIRMACAO_RECEPCAO): quando a equipe manda a mensagem de confirmação da sessão ("Passando para confirmar sua sessão do dia ..."),
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
      for (const e of echoMessages(change)) {
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
    const regras = [];
    if (this.cfg.ligado) regras.push({ frases: this.cfg.frases, coluna: this.cfg.coluna, etiqueta: this.cfg.etiqueta, protegeEtapas: false });
    regras.push(...(this.cfg.regras || []));
    this.regras = regras.map((r) => ({ ...r, frases: r.frases.map(normalize).filter(Boolean) })).filter((r) => r.frases.length);
    this.protegidas = (this.cfg.protegidas || []).map(normalize);
    this.colunas = {};
    this.tags = {};
    this.timers = new Set();
  }

  get ligado() { return this.regras.length > 0; }

  /** Frases da regra da Recepção (compatibilidade com o /recepcao). */
  get frases() { return this.regras.flatMap((r) => r.frases); }

  regraDe(text) { return this.regras.findIndex((r) => isConfirmation(text, r.frases)); }

  get st() { return (this.store.state.recepcao ||= { feitos: {}, log: [] }); }

  log(entry) {
    const st = this.st;
    st.log.unshift({ em: agoraBr(), ...entry });
    st.log.length = Math.min(st.log.length, 100);
    this.store.save();
  }

  /** Recebe uma mensagem da equipe; se for confirmação de sessão, agenda a mudança de etapa. */
  handle(m, delayMs = 0) {
    if (!m || !this.ligado) return false;
    const regra = this.regraDe(m.text);
    if (regra < 0) return false;
    const key = m.messageId || `${m.phone}:${normalize(m.text).slice(0, 60)}`;
    if (this.st.feitos[key]) return false;
    this.st.feitos[key] = Math.floor(Date.now() / 1000);
    this.store.save();
    this.schedule({ key, m, regra, attempts: 0 }, delayMs);
    return true;
  }

  schedule(job, delayMs) {
    const t = setTimeout(() => { this.timers.delete(t); this.run(job); }, delayMs);
    this.timers.add(t);
  }

  async run(job) {
    const { m } = job;
    const regra = this.regras[job.regra ?? this.regraDe(m.text)] || this.regras[0];
    const destino = regra.coluna;
    try {
      const contactId = m.contactId || (await this.contactByPhone(m.phone));
      const { column, pipelineId } = await this.coluna(destino);
      const r = await this.revvy.request(`/api/v1/deals?contact_id=${encodeURIComponent(contactId)}&limit=50`);
      const list = (r.data || r.deals || []).filter((d) => (d.contact_id ?? d.contact?.id ?? contactId) === contactId);
      const colOf = (d) => d.column_id ?? d.column?.id;
      const nomeDe = (d) => d.column?.name || d.column_name || '';
      let resultado;
      if (list.some((d) => colOf(d) === column.id)) {
        resultado = `já estava em ${destino}`;
      } else if (list.length) {
        list.sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
        const atual = list[0];
        if (regra.protegeEtapas && this.protegidas.includes(normalize(nomeDe(atual)))) {
          this.log({ resultado: `não moveu: card está em "${nomeDe(atual)}"`, destino, contato: contactId, telefone: m.phone });
          return;
        }
        await this.revvy.request('/api/v1/deals/move', 0, {
          method: 'POST', body: { deal_id: atual.id, column_id: column.id }, headers: { 'Idempotency-Key': `recepcao-${job.key}`.slice(0, 128) },
        });
        resultado = `card movido de "${nomeDe(atual) || colOf(atual) || '?'}" para ${destino}`;
      } else {
        await this.revvy.createDeal({ contact: { phone: m.phone }, kanban: { sector_id: pipelineId, column_id: column.id } }, `recepcao-${job.key}`.slice(0, 128));
        resultado = `card criado em ${destino}`;
      }
      const tagId = await this.tagId(regra.etiqueta);
      if (tagId) await this.revvy.request('/api/v1/contacts/tags', 0, { method: 'POST', body: { contact_id: contactId, tag_ids: [tagId] } });
      this.log({ resultado, destino, contato: contactId, telefone: m.phone });
    } catch (err) {
      job.attempts += 1;
      if (job.attempts < 3) {
        this.log({ resultado: 'nova tentativa', destino, telefone: m.phone, detalhe: err.message });
        this.schedule(job, job.attempts * 60_000);
      } else {
        this.log({ resultado: 'erro', destino, telefone: m.phone, detalhe: err.message });
        this.logger.error(`[mensagem → etapa] desistiu do contato ${m.phone}: ${err.message}`);
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

  async coluna(nome) {
    const alvo = normalize(nome);
    if (!this.colunas[alvo]) {
      const r = await this.revvy.request('/api/v1/columns');
      for (const p of r.pipelines || []) {
        const column = (p.columns || []).find((c) => normalize(c.name) === alvo);
        if (column) { this.colunas[alvo] = { column, pipelineId: p.id }; break; }
      }
      if (!this.colunas[alvo]) throw new Error(`etapa "${nome}" não existe no Revvy`);
    }
    return this.colunas[alvo];
  }

  async tagId(nome) {
    if (!nome) return null;
    const k = normalize(nome);
    if (this.tags[k] === undefined) {
      const r = await this.revvy.request('/api/v1/tags');
      this.tags[k] = (r.data || r.tags || []).find((t) => normalize(t.name) === k)?.id || null;
      if (!this.tags[k]) this.logger.warn(`[mensagem → etapa] etiqueta "${nome}" não existe no Revvy; o card muda de etapa sem etiqueta`);
    }
    return this.tags[k];
  }

  stop() { for (const t of this.timers) clearTimeout(t); this.timers.clear(); }
}
