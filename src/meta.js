import crypto from 'node:crypto';
import { normalize } from './config.js';

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_AGE = 7 * 24 * 3600 - 300; // a Meta aceita até 7 dias para trás

// Estado de cada DDD brasileiro: o contato do WhatsApp quase nunca tem estado preenchido no Revvy
const UF_POR_DDD = {
  ac: [68], al: [82], am: [92, 97], ap: [96], ba: [71, 73, 74, 75, 77], ce: [85, 88], df: [61],
  es: [27, 28], go: [62, 64], ma: [98, 99], mg: [31, 32, 33, 34, 35, 37, 38], ms: [67], mt: [65, 66],
  pa: [91, 93, 94], pb: [83], pe: [81, 87], pi: [86, 89], pr: [41, 42, 43, 44, 45, 46], rj: [21, 22, 24],
  rn: [84], ro: [69], rr: [95], rs: [51, 53, 54, 55], sc: [47, 48, 49], se: [79],
  sp: [11, 12, 13, 14, 15, 16, 17, 18, 19], to: [63],
};
const DDD_UF = Object.fromEntries(Object.entries(UF_POR_DDD).flatMap(([uf, ddds]) => ddds.map((d) => [d, uf])));

/** Dados do contato em hash, no formato que a Meta pede. */
export function hashedUserData(contact) {
  const ud = {};
  const email = normalize(contact.email).replace(/\s/g, '');
  if (email.includes('@')) ud.em = [sha256(email)];
  // Contatos do Instagram/Messenger vêm como "instagram:123..." no campo telefone: não é telefone
  const rawPhone = String(contact.phone || '');
  let phone = /^[a-z_]+:/i.test(rawPhone) ? '' : rawPhone.replace(/\D/g, '');
  if (phone && phone.length <= 11) phone = '55' + phone; // sem DDI: assume Brasil
  if (phone.length >= 10) ud.ph = [sha256(phone)];
  const names = normalize(contact.name).split(' ').filter((n) => /[a-z]/.test(n)); // ignora nome que é só o número
  if (names.length) ud.fn = [sha256(names[0])];
  if (names.length > 1) ud.ln = [sha256(names[names.length - 1])];
  if (contact.city) ud.ct = [sha256(normalize(contact.city).replace(/[^a-z]/g, ''))];
  if (contact.state) ud.st = [sha256(normalize(contact.state).replace(/[^a-z]/g, ''))];
  else if (phone.startsWith('55') && DDD_UF[phone.slice(2, 4)]) ud.st = [sha256(DDD_UF[phone.slice(2, 4)])];
  ud.country = [sha256('br')];
  if (contact.id) ud.external_id = [sha256(String(contact.id))];
  return ud;
}

export const MESSAGING_ROUTES = ['whatsapp', 'instagram', 'messenger'];

/** Decide a rota (crm / whatsapp / instagram / messenger / site) a partir do contato. */
/** O Revvy pode devolver os campos personalizados como objeto { chave: valor } ou como lista. */
function customFields(contact) {
  const raw = contact.custom_fields;
  if (!Array.isArray(raw)) return raw || {};
  const out = {};
  for (const f of raw) {
    const k = f?.key ?? f?.field_key ?? f?.name ?? f?.slug;
    if (k) out[k] = f.value ?? f.field_value ?? '';
  }
  return out;
}

export function detectRoute(contact, cfg) {
  const cf = customFields(contact);
  const leadId = String(cf[cfg.fields.metaLeadId] || '').replace(/\D/g, '');
  if (leadId.length >= 15 && leadId.length <= 17) return { route: 'crm', leadId };
  // O Revvy guarda o ctwa_clid na origem da conversa (anúncio de clique para WhatsApp)
  const fromSource = [contact.source, ...(contact.conversations || [])]
    .map((x) => x?.source_metadata?.ctwa_clid)
    .find(Boolean);
  const ctwa = String(cf[cfg.fields.ctwaClid] || fromSource || '').trim();
  if (ctwa && cfg.meta.wabaId) return { route: 'whatsapp', ctwaClid: ctwa };
  const [, channel, scopedId] = String(contact.phone || '').match(/^(instagram|messenger):\s*(\d+)$/i) || [];
  if (channel?.toLowerCase() === 'instagram') {
    if (cfg.meta.igAccountId) return { route: 'instagram', scopedId };
    return { route: 'site', missing: 'contato do Instagram: envio do Direct não está liberado (veja a linha [instagram] no log)' };
  }
  if (channel?.toLowerCase() === 'messenger') {
    if (cfg.meta.pageId) return { route: 'messenger', scopedId };
    return { route: 'site', missing: 'contato do Messenger: preencha FACEBOOK_PAGE_ID' };
  }
  return {
    route: 'site',
    fbc: String(cf[cfg.fields.fbc] || '').trim(),
    fbp: String(cf[cfg.fields.fbp] || '').trim(),
  };
}

export function findStage(cfg, name) {
  const key = normalize(name);
  return cfg.stages.find((s) => s.key === key) || cfg.stages.find((s) => s.aliases?.includes(key)) || null;
}

/**
 * Monta o evento. Retorna { event } ou { skip: motivo }.
 */
export function buildEvent({ cfg, deal, contact, stage, eventTime, routeInfo, lossReason, now = Date.now() }) {
  const nowS = Math.floor(now / 1000);
  const t = Math.min(Number(eventTime) || nowS, nowS);
  if (nowS - t > MAX_AGE) return { skip: 'evento com mais de 7 dias' };

  const column = MESSAGING_ROUTES.includes(routeInfo.route) ? 'mensagens' : routeInfo.route;
  const name = column === 'mensagens' ? (stage.mensagens ?? stage.whatsapp) : stage[column];
  if (!name) return { skip: `etapa "${stage.coluna}" não é enviada na rota ${routeInfo.route}` };

  const value = stage.enviar_valor && Number(deal.value) > 0 ? { currency: cfg.meta.currency, value: Number(deal.value) } : {};
  const eventId = `${deal.id}:${stage.key.replace(/\s+/g, '_')}`;
  let event;

  if (routeInfo.route === 'crm') {
    event = {
      event_name: name,
      event_time: t,
      action_source: 'system_generated',
      user_data: { lead_id: Number(routeInfo.leadId), ...hashedUserData(contact) },
      custom_data: { event_source: 'crm', lead_event_source: cfg.meta.leadEventSource, ...value },
    };
  } else if (routeInfo.route === 'whatsapp') {
    event = {
      event_name: name,
      event_time: t,
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: { whatsapp_business_account_id: String(cfg.meta.wabaId), ctwa_clid: routeInfo.ctwaClid },
      custom_data: { ...value },
    };
  } else if (routeInfo.route === 'instagram' || routeInfo.route === 'messenger') {
    event = {
      event_name: name,
      event_time: t,
      action_source: 'business_messaging',
      messaging_channel: routeInfo.route,
      user_data: routeInfo.route === 'instagram'
        ? { instagram_business_account_id: String(cfg.meta.igAccountId), ig_sid: routeInfo.scopedId }
        : { page_id: String(cfg.meta.pageId), page_scoped_user_id: routeInfo.scopedId },
      custom_data: { ...value },
    };
  } else {
    const ud = hashedUserData(contact);
    if (routeInfo.fbc) ud.fbc = routeInfo.fbc;
    if (routeInfo.fbp) ud.fbp = routeInfo.fbp;
    if (!ud.em && !ud.ph && !ud.fbc) return { skip: routeInfo.missing || 'contato sem e-mail, telefone ou fbc' };
    event = {
      event_name: name,
      event_time: t,
      action_source: 'system_generated',
      user_data: ud,
      custom_data: { lead_event_source: cfg.meta.leadEventSource, ...value },
    };
  }
  if (lossReason && !stage.funil) event.custom_data.motivo_perda = String(lossReason);
  event.event_id = eventId;
  return { event };
}

export class MetaClient {
  constructor(metaCfg, { fetchImpl = fetch } = {}) {
    this.cfg = metaCfg;
    this.fetch = fetchImpl;
  }

  /** Conjunto de dados de cada rota: WhatsApp, Instagram e Messenger podem ter um próprio. */
  datasetFor(route) {
    if (route === 'whatsapp' && this.cfg.waDatasetId) return this.cfg.waDatasetId;
    if (route === 'instagram' && this.cfg.igDatasetId) return this.cfg.igDatasetId;
    if (route === 'messenger' && this.cfg.pageDatasetId) return this.cfg.pageDatasetId;
    return this.cfg.datasetId;
  }

  /**
   * Pede à Meta o conjunto de dados ligado à conta do Instagram (a Meta exige esse para eventos do Direct).
   * Se já existir, a Meta devolve o mesmo id; não cria duplicado.
   */
  async instagramDataset() {
    const { graphUrl, graphVersion, accessToken, igAccountId } = this.cfg;
    const url = `${graphUrl}/${graphVersion}/${igAccountId}/dataset?access_token=${encodeURIComponent(accessToken)}`;
    const res = await this.fetch(url, { method: 'POST' });
    const text = await res.text();
    if (!res.ok) throw new Error(`Meta respondeu ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text).id;
  }

  async send(events, { route, attempt = 0 } = {}) {
    const { graphUrl, graphVersion, accessToken, testEventCode } = this.cfg;
    const datasetId = this.datasetFor(route);
    const url = `${graphUrl}/${graphVersion}/${datasetId}/events?access_token=${encodeURIComponent(accessToken)}`;
    const body = { data: events };
    if (testEventCode) body.test_event_code = testEventCode;
    const res = await this.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep((this.cfg.retryBaseMs ?? 2000) * 2 ** attempt);
      return this.send(events, { route, attempt: attempt + 1 });
    }
    if (!res.ok) {
      const err = new Error(`Meta respondeu ${res.status}: ${text.slice(0, 300)}`);
      err.permanent = res.status >= 400 && res.status < 500;
      throw err;
    }
    return JSON.parse(text);
  }
}
