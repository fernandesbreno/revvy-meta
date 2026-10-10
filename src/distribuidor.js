/**
 * Distribui os negócios novos entre as atendentes em rodízio exato (Ana, Eli, Ruana, Ana, ...).
 * O sorteio e o rodízio do próprio Revvy deixam a divisão desigual em volumes pequenos; aqui a vez
 * fica guardada no volume, então 30 leads viram 10, 10 e 10 mesmo depois de reiniciar.
 *
 * Para cada negócio que entra na coluna de entrada depois que a distribuição foi ligada:
 * define a responsável do card e transfere a conversa do contato para ela. A saudação com o nome
 * da atendente sai de um workflow do Revvy com o gatilho "Negócio atribuído a um vendedor".
 * Contato que volta a falar em até 30 dias fica com a mesma atendente e não gasta a vez de ninguém.
 */

const STICKY_S = 30 * 86400;

/** "2026-10-10 00:38:18.98-03" (formato do Revvy) -> epoch em segundos. */
export function revvyTime(s) {
  if (!s) return NaN;
  const iso = String(s).trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  return Math.floor(new Date(iso).getTime() / 1000);
}

/** "Ana:uuid,Eli:uuid" -> [{ nome, id }] */
export function parseAttendants(raw) {
  return String(raw || '').split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.lastIndexOf(':');
    return i > 0 ? { nome: p.slice(0, i).trim(), id: p.slice(i + 1).trim() } : { nome: p, id: p };
  }).filter((a) => a.id);
}

const DIAS = { dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6 };

/**
 * "seg-sex 08:00-18:00; sab 08:00-12:00" -> [{ dias:Set, ini, fim }] em minutos do dia.
 * Vazio = 24 horas.
 */
export function parseHours(raw) {
  return String(raw || '').split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
    const m = p.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .match(/^([a-z]{3})(?:\s*-\s*([a-z]{3}))?\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m || !(m[1] in DIAS) || (m[2] && !(m[2] in DIAS))) throw new Error(`DISTRIBUIR_HORARIO inválido: "${p}"`);
    const dias = new Set();
    for (let d = DIAS[m[1]]; ; d = (d + 1) % 7) { dias.add(d); if (d === DIAS[m[2] || m[1]]) break; }
    return { dias, ini: +m[3] * 60 + +m[4], fim: +m[5] * 60 + +m[6] };
  });
}

/** Está dentro do horário? Fuso fixo de Fortaleza/Brasília (UTC-3, sem horário de verão). */
export function isOpen(hours, now = Date.now(), offsetMin = -180) {
  if (!hours.length) return true;
  const t = new Date(now + offsetMin * 60000);
  const dia = t.getUTCDay();
  const min = t.getUTCHours() * 60 + t.getUTCMinutes();
  return hours.some((h) => h.dias.has(dia) && min >= h.ini && min < h.fim);
}

export class Distributor {
  constructor({ cfg, store, revvy, logger = console }) {
    Object.assign(this, { cfg, store, revvy, logger });
    this.running = false;
    this.columnId = cfg.distribuir.columnId || null;
    this.lastError = '';
  }

  get st() {
    return (this.store.state.distribuicao ||= { inicio: 0, vez: 0, feitos: {}, contatos: {}, contagem: {} });
  }

  async resolveColumn() {
    if (this.columnId) return this.columnId;
    const r = await this.revvy.request('/api/v1/columns');
    const list = r.data || r.columns || [];
    const want = this.cfg.distribuir.column.toLowerCase();
    const col = list.find((c) => String(c.name || '').toLowerCase() === want);
    if (!col) throw new Error(`coluna "${this.cfg.distribuir.column}" não encontrada no Revvy`);
    this.columnId = col.id;
    return col.id;
  }

  async newDeals(columnId) {
    const out = [];
    for (let offset = 0; offset < 2000; offset += 100) {
      const r = await this.revvy.request(`/api/v1/deals?column_id=${encodeURIComponent(columnId)}&limit=100&offset=${offset}`);
      const page = r.data || [];
      out.push(...page);
      if (page.length < 100 || r.pagination?.has_more === false) break;
    }
    const st = this.st;
    return out
      .filter((d) => (d.column_id ? d.column_id === columnId : true))
      .filter((d) => !st.feitos[d.id] && revvyTime(d.created_at) >= st.inicio)
      .sort((a, b) => revvyTime(a.created_at) - revvyTime(b.created_at));
  }

  pick(contactId, nowS) {
    const st = this.st;
    const list = this.cfg.distribuir.atendentes;
    const prev = contactId && st.contatos[contactId];
    if (prev && prev.em >= nowS - STICKY_S) {
      const same = list.find((a) => a.id === prev.id);
      if (same) return { ...same, repetido: true };
    }
    const a = list[st.vez % list.length];
    st.vez = (st.vez + 1) % list.length;
    return a;
  }

  async assign(deal, who) {
    await this.revvy.request(`/api/v1/deals/${encodeURIComponent(deal.id)}`, 0, { method: 'PUT', body: { assigned_user_id: who.id } });
    if (!deal.contact_id) return;
    const contact = await this.revvy.getContact(deal.contact_id);
    const convs = (contact.conversations || []).filter((c) => c.status !== 'closed');
    for (const c of convs) {
      await this.revvy.request('/api/v1/conversations/transfer', 0, { method: 'POST', body: { conversation_id: c.id, user_id: who.id } });
    }
  }

  async run({ now = Date.now() } = {}) {
    if (this.running) return null;
    this.running = true;
    const nowS = Math.floor(now / 1000);
    const st = this.st;
    if (!st.inicio) { st.inicio = nowS; this.store.save(); } // só distribui o que entrar daqui para frente
    // fora do horário os leads esperam; na abertura saem todos, do mais antigo para o mais novo
    if (!isOpen(this.cfg.distribuir.horario, now)) { this.running = false; return { fechado: true }; }
    let done = 0;
    try {
      const columnId = await this.resolveColumn();
      for (const deal of await this.newDeals(columnId)) {
        const who = this.pick(deal.contact_id, nowS);
        try {
          await this.assign(deal, who);
        } catch (err) {
          if (!who.repetido) st.vez = (st.vez + this.cfg.distribuir.atendentes.length - 1) % this.cfg.distribuir.atendentes.length; // devolve a vez
          this.logger.error(`[distribuição] negócio ${deal.id}: ${err.message}`);
          st.falhas ||= {};
          st.falhas[deal.id] = (st.falhas[deal.id] || 0) + 1;
          if (st.falhas[deal.id] >= 5) { st.feitos[deal.id] = nowS; delete st.falhas[deal.id]; } // desiste depois de 5 tentativas
          continue;
        }
        st.feitos[deal.id] = nowS;
        if (deal.contact_id) st.contatos[deal.contact_id] = { id: who.id, em: nowS };
        if (!who.repetido) st.contagem[who.nome] = (st.contagem[who.nome] || 0) + 1;
        done++;
        this.store.log({ resultado: 'distribuído', negocio: deal.id, atendente: who.nome, ...(who.repetido ? { detalhe: 'mesma atendente do contato' } : {}) });
        this.logger.log(`[distribuição] negócio ${deal.id} → ${who.nome}${who.repetido ? ' (contato já era dela)' : ''}`);
      }
      this.prune(nowS);
      this.store.save();
      this.lastError = '';
      return { distribuidos: done };
    } catch (err) {
      const msg = `[distribuição] não consegui ler os negócios: ${err.message}`;
      if (msg !== this.lastError) this.logger.error(msg);
      this.lastError = msg;
      this.store.save();
      return { error: err.message };
    } finally {
      this.running = false;
    }
  }

  prune(nowS) {
    const st = this.st;
    for (const [k, t] of Object.entries(st.feitos)) if (t < nowS - 90 * 86400) delete st.feitos[k];
    for (const [k, v] of Object.entries(st.contatos)) if (v.em < nowS - STICKY_S) delete st.contatos[k];
  }
}
