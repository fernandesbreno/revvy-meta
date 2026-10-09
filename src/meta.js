import crypto from 'node:crypto';
import { normalize } from './config.js';

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_AGE = 7 * 24 * 3600 - 300; // a Meta aceita até 7 dias para trás

/** Dados do contato em hash, no formato que a Meta pede. */
export function hashedUserData(contact) {
  const ud = {};
  const email = normalize(contact.email).replace(/\s/g, '');
  if (email.includes('@')) ud.em = [sha256(email)];
  let phone = String(contact.phone || '').replace(/\D/g, '');
  if (phone && phone.length <= 11) phone = '55' + phone; // sem DDI: assume Brasil
  if (phone.length >= 10) ud.ph = [sha256(phone)];
  const names = normalize(contact.name).split(' ').filter(Boolean);
  if (names.length) ud.fn = [sha256(names[0])];
  if (names.length > 1) ud.ln = [sha256(names[names.length - 1])];
  if (contact.city) ud.ct = [sha256(normalize(contact.city).replace(/[^a-z]/g, ''))];
  if (contact.state) ud.st = [sha256(normalize(contact.state).replace(/[^a-z]/g, ''))];
  ud.country = [sha256('br')];
  if (contact.id) ud.external_id = [sha256(String(contact.id))];
  return ud;
}

/** Decide a rota (crm / whatsapp / site) a partir dos campos personalizados do contato. */
export function detectRoute(contact, cfg) {
  const cf = contact.custom_fields || {};
  const leadId = String(cf[cfg.fields.metaLeadId] || '').replace(/\D/g, '');
  if (leadId.length >= 15 && leadId.length <= 17) return { route: 'crm', leadId };
  const ctwa = String(cf[cfg.fields.ctwaClid] || '').trim();
  if (ctwa && cfg.meta.wabaId) return { route: 'whatsapp', ctwaClid: ctwa };
  return {
    route: 'site',
    fbc: String(cf[cfg.fields.fbc] || '').trim(),
    fbp: String(cf[cfg.fields.fbp] || '').trim(),
  };
}

export function findStage(cfg, name) {
  const key = normalize(name);
  return cfg.stages.find((s) => s.key === key) || null;
}

/**
 * Monta o evento. Retorna { event } ou { skip: motivo }.
 */
export function buildEvent({ cfg, deal, contact, stage, eventTime, routeInfo, lossReason, now = Date.now() }) {
  const nowS = Math.floor(now / 1000);
  const t = Math.min(Number(eventTime) || nowS, nowS);
  if (nowS - t > MAX_AGE) return { skip: 'evento com mais de 7 dias' };

  const name = stage[routeInfo.route];
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
  } else {
    const ud = hashedUserData(contact);
    if (routeInfo.fbc) ud.fbc = routeInfo.fbc;
    if (routeInfo.fbp) ud.fbp = routeInfo.fbp;
    if (!ud.em && !ud.ph && !ud.fbc) return { skip: 'contato sem e-mail, telefone ou fbc' };
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

  async send(events, attempt = 0) {
    const { graphUrl, graphVersion, datasetId, accessToken, testEventCode } = this.cfg;
    const url = `${graphUrl}/${graphVersion}/${datasetId}/events?access_token=${encodeURIComponent(accessToken)}`;
    const body = { data: events };
    if (testEventCode) body.test_event_code = testEventCode;
    const res = await this.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep((this.cfg.retryBaseMs ?? 2000) * 2 ** attempt);
      return this.send(events, attempt + 1);
    }
    if (!res.ok) {
      const err = new Error(`Meta respondeu ${res.status}: ${text.slice(0, 300)}`);
      err.permanent = res.status >= 400 && res.status < 500;
      throw err;
    }
    return JSON.parse(text);
  }
}
