import crypto from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Valida X-Webhook-Signature = sha256=HMAC_SHA256(timestamp + "." + corpo_bruto, secret). */
export function verifySignature({ secret, timestamp, signature, rawBody, maxAgeSeconds = 600, now = Date.now() }) {
  if (!timestamp || !signature) return { ok: false, reason: 'sem assinatura' };
  const ts = Number(timestamp) > 1e12 ? Number(timestamp) / 1000 : Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > maxAgeSeconds) return { ok: false, reason: 'timestamp fora da janela' };
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  const got = String(signature).replace(/^sha256=/i, '').toLowerCase();
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'assinatura inválida' };
  return { ok: true };
}

const get = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function first(body, ...paths) {
  for (const p of paths) {
    const v = get(body, p);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/**
 * Extrai do webhook o que interessa. O formato exato do payload não está na documentação do Revvy,
 * então procuramos os campos em vários lugares prováveis.
 */
export function parseWebhook(body) {
  body = body || {};
  const evento = String(first(body, 'event', 'type', 'event_type', 'action', 'evento', 'data.event') || '');
  if (/^call\./i.test(evento)) return null;

  const dealId = first(body,
    'deal_id', 'data.deal_id', 'deal.id', 'data.deal.id', 'card_id', 'data.card_id', 'card.id', 'data.card.id',
    'payload.deal_id', 'payload.deal.id', 'data.id', 'id');
  if (!dealId) return null;

  const toColumn = first(body, 'to_column', 'data.to_column', 'payload.to_column', 'column', 'data.column', 'deal.column', 'data.deal.column');
  const status = String(first(body, 'deal_status', 'data.deal_status', 'deal.deal_status', 'data.deal.deal_status', 'status', 'data.status') || '');
  let forcedStage = null;
  if (/won|win|ganh/i.test(evento) || /^won$/i.test(status)) forcedStage = 'ganho';
  if (/lost|lose|perd/i.test(evento) || /^lost$/i.test(status)) forcedStage = 'perdido';

  const when = first(body, 'moved_at', 'data.moved_at', 'deal_closed_at', 'data.deal_closed_at', 'timestamp', 'data.timestamp', 'created_at', 'data.created_at');
  let eventTime = when ? Math.floor(new Date(when).getTime() / 1000) : NaN;
  if (!Number.isFinite(eventTime)) eventTime = Math.floor(Date.now() / 1000);

  return {
    evento,
    dealId: String(dealId),
    columnName: toColumn && typeof toColumn === 'object' ? toColumn.name || null : typeof toColumn === 'string' ? toColumn : null,
    forcedStage,
    eventTime,
    lossReason: first(body, 'loss_reason_name', 'data.loss_reason_name', 'loss_reason.name', 'data.loss_reason.name') || null,
  };
}

export class RevvyClient {
  constructor({ baseUrl, apiKey }, { fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
  }

  async request(pathAndQuery, attempt = 0) {
    const res = await this.fetch(this.baseUrl + pathAndQuery, {
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
    });
    if (res.status === 429 && attempt < 5) {
      const wait = Number(res.headers.get('retry-after') || 2) * 1000;
      await sleep(wait);
      return this.request(pathAndQuery, attempt + 1);
    }
    if (res.status >= 500 && attempt < 3) {
      await sleep(1000 * 2 ** attempt);
      return this.request(pathAndQuery, attempt + 1);
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok) throw new Error(`Revvy ${pathAndQuery} respondeu ${res.status}: ${text.slice(0, 200)}`);
    return json;
  }

  async getDeal(id) {
    const r = await this.request(`/api/v1/deals/${encodeURIComponent(id)}`);
    return r.data || r.deal || r;
  }

  async getContact(id) {
    const r = await this.request(`/api/v1/contacts/${encodeURIComponent(id)}`);
    return r.data || r.contact || r;
  }

  async listDeals({ limit = 100, offset = 0 } = {}) {
    return this.request(`/api/v1/deals?limit=${limit}&offset=${offset}`);
  }

  async stageHistory(id) {
    const r = await this.request(`/api/v1/deals/${encodeURIComponent(id)}/stage-history?limit=500`);
    return (r.data && r.data.history) || [];
  }
}
