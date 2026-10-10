/**
 * Traz os leads dos formulários de anúncio da Meta para o Revvy.
 * Cada lead vira contato (com o campo meta_lead_id preenchido) e card na coluna de entrada.
 * Com o meta_lead_id no contato, as etapas desse card vão para a Meta pela rota CRM,
 * que é o que libera a otimização para leads qualificados.
 */

const OVERLAP_S = 3600; // relê a última hora a cada rodada; o registro de importados evita duplicar

/** Respostas do formulário em { campo: valor }. */
export function answers(lead) {
  const out = {};
  for (const f of lead.field_data || []) out[f.name] = (f.values || []).join(', ');
  return out;
}

function pick(a, re) {
  const k = Object.keys(a).find((key) => re.test(key));
  return k ? String(a[k]).trim() : '';
}

/** Extrai nome, telefone e e-mail das respostas, aceitando os nomes de campo mais comuns. */
export function leadContact(lead) {
  const a = answers(lead);
  let phone = pick(a, /phone|telefone|celular|whats/i).replace(/\D/g, '');
  if (phone.startsWith('0')) phone = phone.replace(/^0+/, '');
  if (phone && phone.length <= 11) phone = '55' + phone; // sem DDI: assume Brasil
  const first = pick(a, /^first_name$/i);
  const last = pick(a, /^last_name$/i);
  const name = pick(a, /^full_name$/i) || [first, last].filter(Boolean).join(' ') || pick(a, /nome|name/i);
  const email = pick(a, /e-?mail/i);
  return { name: name || phone, phone, email };
}

export class LeadsImporter {
  constructor({ cfg, store, revvy, fetchImpl = fetch, logger = console }) {
    Object.assign(this, { cfg, store, revvy, logger });
    this.fetch = fetchImpl;
    this.pageToken = null;
    this.lastError = '';
    this.running = false;
  }

  async graph(pathAndQuery, token) {
    const { graphUrl, graphVersion } = this.cfg.meta;
    const url = pathAndQuery.startsWith('http')
      ? pathAndQuery
      : `${graphUrl}/${graphVersion}/${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
    const res = await this.fetch(url);
    const text = await res.text();
    if (!res.ok) throw new Error(`Meta respondeu ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }

  async all(first, token) {
    const items = [];
    let r = await this.graph(first, token);
    for (;;) {
      items.push(...(r.data || []));
      if (!r.paging?.next || !r.data?.length) return items;
      r = await this.graph(r.paging.next, token);
    }
  }

  /**
   * Os leads só saem com o token da página; se o token configurado for de usuário/sistema, pega o da página.
   * O token da página tirado de um token de usuário longo não expira, então fica guardado no volume:
   * continua valendo depois que o token de usuário (60 dias) vencer.
   */
  async token() {
    if (this.pageToken) return this.pageToken;
    const { pageId, token } = this.cfg.leads;
    const st = (this.store.state.leads ||= { importados: {}, desde: 0 });
    try {
      const r = await this.graph(`${pageId}?fields=access_token`, token);
      this.pageToken = r.access_token || token;
      if (r.access_token) { st.tokenPagina = r.access_token; this.store.save(); }
    } catch {
      this.pageToken = st.tokenPagina || token; // já é um token de página, ou o de usuário venceu
    }
    return this.pageToken;
  }

  async run({ now = Date.now() } = {}) {
    if (this.running) return null;
    this.running = true;
    const runStart = Math.floor(now / 1000);
    const st = (this.store.state.leads ||= { importados: {}, desde: 0 });
    if (!st.desde) st.desde = runStart - this.cfg.leads.daysBack * 86400;
    let imported = 0;
    let failed = 0;
    try {
      const token = await this.token();
      const forms = await this.all(`${this.cfg.leads.pageId}/leadgen_forms?fields=id,name&limit=100`, token);
      const filter = encodeURIComponent(JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: st.desde - OVERLAP_S }]));
      for (const form of forms) {
        const leads = await this.all(`${form.id}/leads?fields=id,created_time,field_data,form_id&limit=100&filtering=${filter}`, token);
        for (const lead of leads) {
          if (st.importados[lead.id]) continue;
          try {
            const res = await this.importLead(lead, form);
            st.importados[lead.id] = runStart;
            this.store.log({ resultado: res.skip ? 'ignorado' : 'lead importado', lead: lead.id, formulario: form.name, ...(res.skip ? { detalhe: res.skip } : { negocio: res.dealId }) });
            if (!res.skip) {
              imported++;
              this.logger.log(`[formulário] lead ${lead.id} (${form.name}) virou o negócio ${res.dealId} em "${this.cfg.leads.column}"`);
            } else {
              this.logger.warn(`[formulário] lead ${lead.id} ignorado: ${res.skip}`);
            }
          } catch (err) {
            failed++;
            this.logger.error(`[formulário] lead ${lead.id}: ${err.message}`);
          }
        }
      }
      if (!failed) st.desde = runStart; // com falha, a próxima rodada relê o mesmo período
      this.prune(runStart);
      this.store.save();
      this.lastError = '';
      if (imported) this.logger.log(`[formulário] ${imported} lead(s) novo(s) no Revvy`);
      return { forms: forms.length, imported, failed };
    } catch (err) {
      const msg = `[formulário] não consegui ler os leads da página ${this.cfg.leads.pageId} (o token precisa da permissão leads_retrieval e acesso à página): ${err.message}`;
      if (msg !== this.lastError) this.logger.error(msg); // não repete a mesma linha a cada rodada
      this.lastError = msg;
      this.pageToken = null;
      return { error: err.message };
    } finally {
      this.running = false;
    }
  }

  prune(nowS) {
    const st = this.store.state.leads;
    for (const [k, t] of Object.entries(st.importados)) if (t < nowS - 90 * 86400) delete st.importados[k];
  }

  async importLead(lead, form) {
    const c = leadContact(lead);
    if (c.phone.length < 12) return { skip: 'lead sem telefone válido (o Revvy exige telefone para criar o card)' };
    const field = this.cfg.fields.metaLeadId;
    const contact = await this.revvy.upsertContact(
      { name: c.name, phone: c.phone, ...(c.email ? { email: c.email } : {}), custom_fields: { [field]: String(lead.id) } },
      `meta-lead-contato-${lead.id}`,
    );
    // contato que já existia: grava o id do lead novo antes de criar o card, para o card já nascer na rota CRM
    if (!contact.created) await this.revvy.updateContact(contact.id, { custom_fields: { [field]: String(lead.id) } });

    const a = answers(lead);
    const notes = [
      `Lead do formulário da Meta "${form.name}" (ID do lead ${lead.id})`,
      Object.entries(a).map(([k, v]) => `${k}: ${v}`).join('\n'),
    ];
    const r = await this.revvy.createDeal({
      contact: { phone: c.phone, name: c.name, ...(c.email ? { email: c.email } : {}) },
      kanban: { sector_name: this.cfg.leads.sector, column_name: this.cfg.leads.column },
      deal: { lead_source: 'Formulário Meta' },
      notes,
    }, `meta-lead-card-${lead.id}`);
    return { dealId: r.deal?.id || r.data?.id || '?' };
  }
}
