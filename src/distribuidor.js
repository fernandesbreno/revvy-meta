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
const norm = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

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

  async columnsList() {
    const r = await this.revvy.request('/api/v1/columns');
    // a API devolve { pipelines: [{ columns: [...] }] }
    return [...(r.data || r.columns || []), ...(r.pipelines || []).flatMap((p) => p.columns || [])];
  }

  async resolveColumn() {
    if (this.columnId && this.extraColumnIds) return this.columnId;
    const list = await this.columnsList();
    const byName = (name) => list.find((c) => String(c.name || '').toLowerCase() === name.toLowerCase());
    if (!this.columnId) {
      const col = byName(this.cfg.distribuir.column);
      if (!col) throw new Error(`coluna "${this.cfg.distribuir.column}" não encontrada no Revvy`);
      this.columnId = col.id;
    }
    this.extraColumnIds = (this.cfg.distribuir.colunasSemDona || []).map((n) => {
      const c = byName(n);
      if (!c) this.logger.warn(`[distribuição] coluna "${n}" não encontrada no Revvy; ignorada`);
      return c?.id;
    }).filter((id) => id && id !== this.columnId);
    return this.columnId;
  }

  async dealsIn(columnId) {
    const out = [];
    for (let offset = 0; offset < 2000; offset += 100) {
      const r = await this.revvy.request(`/api/v1/deals?column_id=${encodeURIComponent(columnId)}&limit=100&offset=${offset}`);
      const page = r.data || [];
      out.push(...page);
      if (page.length < 100 || r.pagination?.has_more === false) break;
    }
    return out.filter((d) => {
      const col = d.column_id ?? d.column?.id;
      return col ? col === columnId : true;
    });
  }

  /**
   * Negócios novos ainda não tratados: os da coluna de entrada e os que já pularam para uma coluna
   * seguinte antes da distribuição (o lead respondeu e a automação moveu o card).
   */
  async newDeals(columnId) {
    const out = await this.dealsIn(columnId);
    for (const id of this.extraColumnIds || []) {
      out.push(...await this.dealsIn(id));
    }
    const st = this.st;
    const seen = new Set();
    return out
      .filter((d) => !seen.has(d.id) && seen.add(d.id))
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

  /** Quem já é dona do negócio ou da conversa (a atendente pegou o lead antes da distribuição). */
  ownerOf(deal, contact) {
    const ids = [deal.assigned_user_id, deal.assigned_user?.id];
    for (const c of contact?.conversations || []) if (c.status !== 'closed') ids.push(c.assigned_user_id, c.assigned_user?.id, c.user_id);
    const id = ids.find(Boolean);
    if (!id) return null;
    const known = this.cfg.distribuir.atendentes.find((a) => a.id === id);
    return known || { id, nome: deal.assigned_user?.id === id ? deal.assigned_user.name : '' };
  }

  /**
   * A empresa falou primeiro: a conversa aberta é mais de 1 minuto mais antiga que o card. O Revvy só cria o
   * card quando o lead responde, então isso é a atendente abordando pelo celular (ex.: lead vindo do Instagram).
   */
  abordadoAntes(deal, contact) {
    const card = revvyTime(deal.created_at);
    if (!Number.isFinite(card)) return false;
    return (contact?.conversations || []).some((c) => c.status !== 'closed' && revvyTime(c.created_at) < card - 60);
  }

  /**
   * Põe o negócio, as conversas abertas e a etiqueta na atendente. Quando ela já é a dona do card
   * (pegou o lead sozinha), o card não é regravado, para não disparar a saudação de novo.
   */
  async assign(deal, who, contact = null) {
    const dealOwner = deal.assigned_user_id || deal.assigned_user?.id;
    if (who.abordado && deal.contact_id && dealOwner !== who.id) {
      // a etiqueta entra antes da atribuição, porque é ela que faz o workflow de saudação pular este lead
      const abordadoId = this.cfg.distribuir.etiquetaAbordado && await this.tagFor(this.cfg.distribuir.etiquetaAbordado);
      if (!abordadoId) throw new Error(`etiqueta ${this.cfg.distribuir.etiquetaAbordado} não existe no Revvy; sem ela a saudação sairia`);
      await this.revvy.request('/api/v1/contacts/tags', 0, { method: 'POST', body: { contact_id: deal.contact_id, tag_ids: [abordadoId] } });
    }
    if (dealOwner !== who.id) {
      await this.revvy.request(`/api/v1/deals/${encodeURIComponent(deal.id)}`, 0, { method: 'PUT', body: { assigned_user_id: who.id } });
    }
    if (!deal.contact_id) return;
    contact ||= await this.revvy.getContact(deal.contact_id);
    const convs = (contact.conversations || []).filter((c) => c.status !== 'closed');
    for (const c of convs) {
      if ((c.assigned_user_id || c.assigned_user?.id || c.user_id) === who.id) continue;
      await this.revvy.request('/api/v1/conversations/transfer', 0, { method: 'POST', body: { conversation_id: c.id, user_id: who.id } });
    }
    // etiqueta com o nome da atendente, aplicada pela API (a aplicada por workflow não chega ao WhatsApp Business)
    const tagId = this.cfg.distribuir.etiquetas && who.nome && await this.tagFor(who.nome);
    if (tagId && !(contact.tags || []).some((t) => t.id === tagId)) {
      try {
        await this.revvy.request('/api/v1/contacts/tags', 0, { method: 'POST', body: { contact_id: deal.contact_id, tag_ids: [tagId] } });
      } catch (err) {
        this.logger.warn(`[distribuição] não consegui pôr a etiqueta ${who.nome}: ${err.message}`);
      }
    }
  }

  /** id da etiqueta com o mesmo nome da atendente (maiúsculas e acentos não importam). */
  async tagFor(nome) {
    if (!this.tags) {
      const r = await this.revvy.request('/api/v1/tags');
      this.tags = r.data || r.tags || [];
    }
    return this.tags.find((t) => norm(t.name) === norm(nome))?.id || null;
  }

  async run({ now = Date.now() } = {}) {
    if (this.running) return null;
    this.running = true;
    const nowS = Math.floor(now / 1000);
    const st = this.st;
    if (!st.inicio) { st.inicio = nowS; this.store.save(); } // só distribui o que entrar daqui para frente
    // fora do horário os leads esperam a abertura (do mais antigo para o mais novo); só os que uma
    // atendente já pegou sozinha são passados para ela, e isso é conferido a cada 2 minutos
    const open = isOpen(this.cfg.distribuir.horario, now);
    if (!open && this.lastClosedCheck && now - this.lastClosedCheck < 120_000) { this.running = false; return { fechado: true }; }
    if (!open) this.lastClosedCheck = now;
    let done = 0;
    try {
      const columnId = await this.resolveColumn();
      for (const deal of await this.newDeals(columnId)) {
        if (this.cfg.distribuir.soWhatsapp && !/^\d{10,15}$/.test(String(deal.contact_phone ?? deal.contact?.phone ?? ''))) {
          st.feitos[deal.id] = nowS; // Instagram, Facebook etc.: fica como está, sem dona nem saudação
          continue;
        }
        let who;
        let contact = null;
        try {
          if (deal.contact_id) contact = await this.revvy.getContact(deal.contact_id);
          const ignorar = (this.cfg.distribuir.ignorarEtiquetas || []).map(norm);
          const etiqueta = (contact?.tags || []).find((t) => ignorar.includes(norm(t.name)));
          if (etiqueta) { // cliente que já comprou: o card fica como está, sem dona nem saudação
            st.feitos[deal.id] = nowS;
            this.store.log({ resultado: 'ignorado', negocio: deal.id, detalhe: `contato com a etiqueta ${etiqueta.name}` });
            this.logger.log(`[distribuição] negócio ${deal.id} ignorado (contato com a etiqueta ${etiqueta.name})`);
            continue;
          }
          const owner = this.ownerOf(deal, contact);
          if (owner) who = { ...owner, pegou: true }; // a atendente abordou antes: fica com ela, sem gastar a vez
          else if (this.cfg.distribuir.etiquetaAbordado && this.abordadoAntes(deal, contact)) who = { ...this.pick(deal.contact_id, nowS), abordado: true }; // abordou pelo celular: atribui sem saudação, a qualquer hora
          else if (!open) continue; // espera a abertura
          else who = this.pick(deal.contact_id, nowS);
          await this.assign(deal, who, contact);
        } catch (err) {
          if (who && !who.repetido && !who.pegou) st.vez = (st.vez + this.cfg.distribuir.atendentes.length - 1) % this.cfg.distribuir.atendentes.length; // devolve a vez
          this.logger.error(`[distribuição] negócio ${deal.id}: ${err.message}`);
          st.falhas ||= {};
          st.falhas[deal.id] = (st.falhas[deal.id] || 0) + 1;
          if (st.falhas[deal.id] >= 5) { st.feitos[deal.id] = nowS; delete st.falhas[deal.id]; } // desiste depois de 5 tentativas
          continue;
        }
        st.feitos[deal.id] = nowS;
        if (deal.contact_id) st.contatos[deal.contact_id] = { id: who.id, em: nowS };
        if (!who.repetido && !who.pegou) st.contagem[who.nome] = (st.contagem[who.nome] || 0) + 1;
        done++;
        const detalhe = who.pegou ? 'a atendente pegou o lead antes da distribuição' : who.abordado ? 'a atendente abordou antes pelo celular (sem saudação)' : who.repetido ? 'mesma atendente do contato' : undefined;
        this.store.log({ resultado: 'distribuído', negocio: deal.id, atendente: who.nome || who.id, ...(detalhe ? { detalhe } : {}) });
        this.logger.log(`[distribuição] negócio ${deal.id} → ${who.nome || who.id}${detalhe ? ` (${detalhe})` : ''}`);
      }
      this.prune(nowS);
      this.store.save();
      this.lastError = '';
      return open ? { distribuidos: done } : { fechado: true, pegos: done };
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
