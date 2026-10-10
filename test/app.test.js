import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { verifySignature, parseWebhook } from '../src/revvy.js';
import { reconcile } from '../src/reconcile.js';
import { leadContact } from '../src/leads.js';
import { revvyTime, parseAttendants, parseHours, isOpen } from '../src/distribuidor.js';

const SECRET = 'segredo-teste';
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const quiet = { log() {}, warn() {}, error: process.env.DEBUG ? console.error : () => {} };

// ---- Revvy + Meta simulados ----
let metaCalls = [];
let metaFail = 0;
let rejectWhatsapp = false;
let deals = {};
let contacts = {};
let histories = {};
let formLeads = [];
let revvyWrites = [];
let mock;
let mockUrl;

before(async () => {
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const u = new URL(req.url, 'http://x');
      if (req.headers.authorization !== 'Bearer chave-revvy' && u.pathname.startsWith('/api')) return send(401, { success: false });
      if (req.method !== 'GET' && u.pathname.startsWith('/api/')) {
        const b = body ? JSON.parse(body) : {};
        revvyWrites.push({ method: req.method, path: u.pathname, body: b, key: req.headers['idempotency-key'] });
        if (u.pathname === '/api/v1/contacts') {
          const existing = Object.values(contacts).find((c) => c.phone === b.phone);
          if (existing) return send(409, { success: false, error: 'CONFLICT', contact_id: existing.id });
          return send(201, { success: true, data: { id: 'novo', ...b } });
        }
        if (u.pathname.startsWith('/api/v1/contacts/')) return send(200, { success: true });
        if (u.pathname === '/api/v1/deals/create') return send(200, { success: true, deal: { id: 'deal-novo' } });
        if (u.pathname === '/api/v1/conversations/transfer') return send(200, { success: true });
        if (u.pathname.startsWith('/api/v1/deals/')) return send(200, { success: true });
      }
      let m;
      if ((m = u.pathname.match(/^\/api\/v1\/deals\/([^/]+)\/stage-history$/))) return send(200, { success: true, data: { history: histories[m[1]] || [] } });
      if ((m = u.pathname.match(/^\/api\/v1\/deals\/([^/]+)$/))) return deals[m[1]] ? send(200, { success: true, data: deals[m[1]] }) : send(404, {});
      if (u.pathname === '/api/v1/tags') return send(200, { success: true, data: [{ id: 't-ana', name: 'Ana' }, { id: 't-eli', name: 'Eli' }, { id: 't-ruana', name: 'Ruana' }] });
      if (u.pathname === '/api/v1/columns') return send(200, { success: true, pipelines: [{ id: 'p1', name: 'Comercial', columns: [{ id: 'col-vendido', name: 'Venda Concluída' }, { id: 'col-novo', name: 'Novo Lead' }, { id: 'col-atend', name: 'Em Atendimento' }] }], count: 1 });
      if (u.pathname === '/api/v1/deals') return send(200, { success: true, data: Object.values(deals), pagination: { has_more: false } });
      if ((m = u.pathname.match(/^\/api\/v1\/contacts\/([^/]+)$/))) return contacts[m[1]] ? send(200, { success: true, data: contacts[m[1]] }) : send(404, {});
      if (req.method === 'GET' && u.pathname.startsWith('/graph/')) {
        if (u.searchParams.get('fields') === 'access_token') return send(200, { access_token: 'tok-pagina', id: '555' });
        if (u.searchParams.get('access_token') !== 'tok-pagina') return send(403, { error: { message: 'sem leads_retrieval' } });
        if (u.pathname.endsWith('/555/leadgen_forms')) return send(200, { data: [{ id: 'f1', name: 'Avaliação grátis' }] });
        if (u.pathname.endsWith('/f1/leads')) return send(200, { data: formLeads });
        return send(404, {});
      }
      if (u.pathname.startsWith('/graph/')) {
        if (metaFail > 0) { metaFail--; return send(500, { error: 'temporário' }); }
        if (rejectWhatsapp && body.includes('"messaging_channel":"whatsapp"')) return send(400, { error: { message: 'sem permissão' } });
        metaCalls.push({ url: req.url, body: JSON.parse(body) });
        return send(200, { events_received: 1, fbtrace_id: 'trace' });
      }
      send(404, {});
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  mockUrl = `http://127.0.0.1:${mock.address().port}`;
});
after(() => mock.close());

let app;
let appUrl;
let dir;
async function startApp(extraEnv = {}) {
  dir = mkdtempSync(path.join(os.tmpdir(), 'rm-'));
  const cfg = loadConfig({
    REVVY_API_KEY: 'chave-revvy', REVVY_WEBHOOK_SECRET: SECRET, META_DATASET_ID: '111', META_ACCESS_TOKEN: 'tok',
    REVVY_BASE_URL: mockUrl, META_GRAPH_URL: mockUrl + '/graph', DATA_DIR: dir, PORT: '0', RECONCILIAR_A_CADA_MINUTOS: '0',
    WHATSAPP_BUSINESS_ACCOUNT_ID: '999', ADMIN_TOKEN: 'adm', META_RETRY_BASE_MS: '5', ...extraEnv,
  });
  app = createApp({ cfg, logger: quiet });
  const server = await app.start();
  appUrl = `http://127.0.0.1:${server.address().port}`;
  return cfg;
}
async function stopApp() { await app.stop(); while (app.processor.running) await new Promise((r) => setTimeout(r, 20)); rmSync(dir, { recursive: true, force: true }); }

function signedPost(body, secret = SECRET, ts = String(Math.floor(Date.now() / 1000))) {
  const raw = JSON.stringify(body);
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  return fetch(appUrl + '/webhooks/revvy', { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-timestamp': ts, 'x-webhook-signature': sig }, body: raw });
}
const settle = async () => { for (let i = 0; i < 50 && app.store.state.pending.length; i++) await new Promise((r) => setTimeout(r, 20)); };
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

beforeEach(() => {
  metaCalls = []; metaFail = 0; rejectWhatsapp = false;
  deals = { d1: { id: 'd1', value: 2500, created_at: ago(120), contact: { id: 'c1', name: 'João da Silva', phone: '5511999999999', email: 'Joao@Exemplo.com' }, column: { name: 'Venda Concluída' } } };
  contacts = { c1: { id: 'c1', name: 'João da Silva', phone: '5511999999999', email: 'Joao@Exemplo.com', city: 'São Paulo', custom_fields: { meta_lead_id: '1234567890123456' } } };
  histories = {};
  formLeads = []; revvyWrites = [];
});

test('assinatura: aceita a correta, recusa errada e antiga', () => {
  const raw = Buffer.from('{"a":1}');
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', 's').update(`${ts}.{"a":1}`).digest('hex');
  assert.equal(verifySignature({ secret: 's', timestamp: ts, signature: 'sha256=' + sig, rawBody: raw }).ok, true);
  assert.equal(verifySignature({ secret: 'x', timestamp: ts, signature: 'sha256=' + sig, rawBody: raw }).ok, false);
  assert.equal(verifySignature({ secret: 's', timestamp: String(Number(ts) - 3600), signature: sig, rawBody: raw }).ok, false);
});

test('parseWebhook encontra negócio e coluna em formatos diferentes', () => {
  assert.equal(parseWebhook({ event: 'card_moved', data: { deal_id: 'x', to_column: { name: 'Venda Concluída' } } }).columnName, 'Venda Concluída');
  assert.equal(parseWebhook({ deal: { id: 'y', column: { name: 'Perdido' } } }).dealId, 'y');
  assert.equal(parseWebhook({ event: 'deal.won', deal_id: 'z' }).forcedStage, 'ganho');
  assert.equal(parseWebhook({ event: 'call.ended', id: 'c' }), null);
});

test('lead de formulário: envia pela rota CRM, preenche etapas puladas e não duplica', async () => {
  await startApp();
  try {
    const r = await signedPost({ event: 'card_moved', data: { deal_id: 'd1', to_column: { name: 'venda concluida' }, moved_at: ago(5) } });
    assert.equal(r.status, 200);
    await settle();
    assert.equal(metaCalls.length, 1);
    const evs = metaCalls[0].body.data;
    assert.deepEqual(evs.map((e) => e.event_name), ['Lead', 'Lead Qualificado', 'Orcamento Enviado', 'Avaliacao Marcada', 'Venda']);
    const venda = evs.at(-1);
    assert.equal(venda.action_source, 'system_generated');
    assert.equal(venda.user_data.lead_id, 1234567890123456);
    assert.deepEqual(venda.user_data.em, [sha('joao@exemplo.com')]);
    assert.deepEqual(venda.user_data.ph, [sha('5511999999999')]);
    assert.deepEqual(venda.custom_data, { event_source: 'crm', lead_event_source: 'Revvy', currency: 'BRL', value: 2500 });
    assert.ok(evs.every((e, i) => i === 0 || e.event_time > evs[i - 1].event_time), 'etapas em ordem crescente de horário');

    await signedPost({ event: 'card_moved', data: { deal_id: 'd1', to_column: { name: 'Venda Concluída' } } });
    await settle();
    assert.equal(metaCalls.length, 1, 'não reenvia a mesma etapa');
  } finally { await stopApp(); }
});

test('campos personalizados em forma de lista: lê o meta_lead_id', async () => {
  contacts.c1.custom_fields = [{ key: 'meta_lead_id', label: 'ID do lead Meta', value: '1234567890123456' }];
  await startApp({ PREENCHER_ETAPAS_PULADAS: 'false' });
  try {
    await signedPost({ data: { deal_id: 'd1', to_column: { name: 'Lead Qualificado' } } });
    await settle();
    assert.equal(metaCalls[0].body.data[0].user_data.lead_id, 1234567890123456);
  } finally { await stopApp(); }
});

test('webhook com assinatura errada é recusado e nada é enviado', async () => {
  await startApp();
  try {
    const r = await signedPost({ data: { deal_id: 'd1', to_column: { name: 'Venda Concluída' } } }, 'errado');
    assert.equal(r.status, 401);
    await settle();
    assert.equal(metaCalls.length, 0);
  } finally { await stopApp(); }
});

test('anúncio de WhatsApp: rota Business Messaging, etapa sem equivalente é ignorada', async () => {
  contacts.c1.custom_fields = { ctwa_clid: 'ARAkLk' };
  await startApp({ PREENCHER_ETAPAS_PULADAS: 'false' });
  try {
    await signedPost({ data: { deal_id: 'd1', to_column: { name: 'Lead Qualificado' } } });
    await settle();
    assert.equal(metaCalls.length, 1);
    const e = metaCalls[0].body.data[0];
    assert.equal(e.event_name, 'LeadSubmitted');
    assert.equal(e.action_source, 'business_messaging');
    assert.deepEqual(e.user_data, { whatsapp_business_account_id: '999', ctwa_clid: 'ARAkLk' });

    await signedPost({ data: { deal_id: 'd1', to_column: { name: 'Lead Frio' } } });
    await settle();
    assert.equal(metaCalls.length, 1, 'lead frio não existe na rota de mensagens');
  } finally { await stopApp(); }
});

test('outras origens: rota padrão com dados em hash e fbc; coluna desconhecida é ignorada', async () => {
  contacts.c1.custom_fields = { fbc: 'fb.1.123.abc' };
  await startApp({ PREENCHER_ETAPAS_PULADAS: 'false' });
  try {
    await signedPost({ data: { deal_id: 'd1', to_column: { name: 'Lead Desqualificado' } } });
    await signedPost({ data: { deal_id: 'd1', to_column: { name: 'Coluna Qualquer' } } });
    await settle();
    assert.equal(metaCalls.length, 1);
    const e = metaCalls[0].body.data[0];
    assert.equal(e.event_name, 'LeadDesqualificado');
    assert.equal(e.user_data.fbc, 'fb.1.123.abc');
    assert.deepEqual(e.user_data.ct, [sha('saopaulo')]);
    assert.equal(e.user_data.lead_id, undefined);
  } finally { await stopApp(); }
});

test('Direct do Instagram: rota Business Messaging com ig_sid e conjunto de dados próprio', async () => {
  deals.d1.contact = { id: 'c2', name: 'maria.ig', phone: 'instagram:28745191678474277' };
  contacts.c2 = { id: 'c2', name: 'maria.ig', phone: 'instagram:28745191678474277', email: null };
  await startApp({ INSTAGRAM_BUSINESS_ACCOUNT_ID: '17841400000000000', META_DATASET_ID_INSTAGRAM: '222' });
  try {
    await signedPost({ data: { deal_id: 'd1', to_column: { name: 'Orçamento Enviado' } } });
    await settle();
    assert.equal(metaCalls.length, 1);
    assert.match(metaCalls[0].url, /\/222\/events/);
    const evs = metaCalls[0].body.data;
    assert.deepEqual(evs.map((e) => e.event_name), ['LeadSubmitted', 'InitiateCheckout']);
    assert.equal(evs[0].messaging_channel, 'instagram');
    assert.deepEqual(evs[0].user_data, { instagram_business_account_id: '17841400000000000', ig_sid: '28745191678474277' });
  } finally { await stopApp(); }
});

test('Instagram sem conta configurada é ignorado com motivo; "instagram:" nunca vira telefone', async () => {
  deals.d1.contact = { id: 'c2', name: 'maria.ig', phone: 'instagram:28745191678474277' };
  contacts.c2 = { id: 'c2', name: 'maria.ig', phone: 'instagram:28745191678474277' };
  await startApp({ PREENCHER_ETAPAS_PULADAS: 'false' });
  try {
    await signedPost({ data: { deal_id: 'd1', to_column: { name: 'Lead Qualificado' } } });
    await settle();
    assert.equal(metaCalls.length, 0);
    assert.match(JSON.stringify(app.store.state.log.at(-1)), /Direct não está liberado/);
  } finally { await stopApp(); }
});

test('WhatsApp sem anúncio: rota padrão pelo telefone, nome que é só número não vira nome', async () => {
  deals.d1.contact = { id: 'c3', name: '5585987106434', phone: '5585987106434' };
  contacts.c3 = { id: 'c3', name: '5585987106434', phone: '5585987106434' };
  await startApp({ PREENCHER_ETAPAS_PULADAS: 'false' });
  try {
    await signedPost({ data: { deal_id: 'd1', to_column: { name: 'Link/Avaliação Marcada' } } });
    await settle();
    const e = metaCalls[0].body.data[0];
    assert.equal(e.event_name, 'Schedule');
    assert.deepEqual(e.user_data.ph, [sha('5585987106434')]);
    assert.equal(e.user_data.fn, undefined);
    assert.match(metaCalls[0].url, /\/111\/events/);
  } finally { await stopApp(); }
});

test('WhatsApp de anúncio: lê o ctwa_clid da origem da conversa no Revvy; se a Meta recusar, envia pelo telefone', async () => {
  deals.d1.contact = { id: 'c3', name: '5585987106434', phone: '5585987106434' };
  contacts.c3 = { id: 'c3', name: '5585987106434', phone: '5585987106434', custom_fields: [{ key: 'fbc', value: '' }],
    source: { source_type: 'ads', source_metadata: { ctwa_clid: 'AfiFMp123' } } };
  await startApp({ PREENCHER_ETAPAS_PULADAS: 'false' });
  try {
    await signedPost({ data: { deal_id: 'd1', to_column: { name: 'Lead Qualificado' } } });
    await settle();
    assert.deepEqual(metaCalls[0].body.data[0].user_data, { whatsapp_business_account_id: '999', ctwa_clid: 'AfiFMp123' });
    assert.equal(metaCalls[0].body.data[0].event_name, 'LeadSubmitted');

    rejectWhatsapp = true;
    await signedPost({ data: { deal_id: 'd1', to_column: { name: 'Orçamento Enviado' } } });
    await settle();
    assert.equal(metaCalls.length, 2);
    const e = metaCalls[1].body.data[0];
    assert.equal(e.event_name, 'InitiateCheckout');
    assert.equal(e.messaging_channel, undefined);
    assert.deepEqual(e.user_data.ph, [sha('5585987106434')]);
  } finally { await stopApp(); }
});

test('falha temporária da Meta: tenta de novo e o trabalho sobrevive', async () => {
  metaFail = 10; // falha mais vezes que as tentativas imediatas
  await startApp({ PREENCHER_ETAPAS_PULADAS: 'false' });
  try {
    await signedPost({ data: { deal_id: 'd1', to_column: { name: 'Venda Concluída' } } });
    for (let i = 0; i < 200 && !app.store.state.pending[0]?.attempts; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(app.store.state.pending.length, 1, 'continua na fila');
    assert.equal(metaCalls.length, 0);
    metaFail = 0;
    app.store.state.pending[0].nextAt = 0;
    await app.processor.drain();
    assert.equal(metaCalls.length, 1);
    assert.equal(app.store.state.pending.length, 0);
  } finally { await stopApp(); }
}, { timeout: 30000 });

test('modo teste envia test_event_code, não repete na mesma execução e não grava como enviado', async () => {
  await startApp({ META_TEST_EVENT_CODE: 'TEST123', PREENCHER_ETAPAS_PULADAS: 'false' });
  try {
    await signedPost({ data: { deal_id: 'd1', to_column: { name: 'Venda Concluída' } } });
    await settle();
    await signedPost({ data: { deal_id: 'd1', to_column: { name: 'Venda Concluída' } } });
    await settle();
    assert.equal(metaCalls.length, 1);
    assert.equal(metaCalls[0].body.test_event_code, 'TEST123');
    assert.deepEqual(app.store.state.sent, {}, 'nada gravado no disco em modo teste');
  } finally { await stopApp(); }
});

test('reconciliação envia movimentações que o webhook perdeu', async () => {
  histories.d1 = [
    { moved_at: ago(100), from_column: null, to_column: { name: 'Novo Lead' } },
    { moved_at: ago(30), from_column: { name: 'Novo Lead' }, to_column: { name: 'Lead Qualificado' } },
    { moved_at: new Date(Date.now() - 10 * 86400000).toISOString(), from_column: null, to_column: { name: 'Venda Concluída' } },
  ];
  const cfg = await startApp({ PREENCHER_ETAPAS_PULADAS: 'false' });
  try {
    const r = await reconcile({ cfg, store: app.store, revvy: app.processor.revvy, processor: app.processor, logger: quiet, pauseMs: 0 });
    assert.equal(r.queued, 2, 'ignora a de 10 dias atrás');
    await settle();
    const names = metaCalls.flatMap((c) => c.body.data.map((e) => e.event_name)).sort();
    assert.deepEqual(names, ['Lead', 'Lead Qualificado']);
    const again = await reconcile({ cfg, store: app.store, revvy: app.processor.revvy, processor: app.processor, logger: quiet, pauseMs: 0 });
    assert.equal(again.queued, 0, 'não repete o que já foi enviado');
  } finally { await stopApp(); }
});

test('/status exige token e não expõe dados pessoais', async () => {
  await startApp({ PREENCHER_ETAPAS_PULADAS: 'false' });
  try {
    await signedPost({ data: { deal_id: 'd1', to_column: { name: 'Venda Concluída' } } });
    await settle();
    assert.equal((await fetch(appUrl + '/status')).status, 401);
    const s = await (await fetch(appUrl + '/status?token=adm')).text();
    assert.match(s, /enviado/);
    assert.doesNotMatch(s, /exemplo\.com|5511999999999/);
  } finally { await stopApp(); }
});

const lead = (id, fields) => ({ id, created_time: new Date().toISOString(), field_data: Object.entries(fields).map(([name, v]) => ({ name, values: [v] })) });

test('leadContact entende os campos do formulário', () => {
  assert.deepEqual(leadContact(lead('1', { full_name: 'Ana Souza', phone_number: '+55 (85) 98888-7777', email: 'ana@x.com' })),
    { name: 'Ana Souza', phone: '5585988887777', email: 'ana@x.com' });
  assert.equal(leadContact(lead('1', { telefone: '85 98888-7777', first_name: 'Ana', last_name: 'S' })).phone, '5585988887777');
});

test('leads de formulário viram contato com meta_lead_id e card em Novo Lead, sem duplicar', async () => {
  formLeads = [
    lead('2131076834161302', { full_name: 'Ana Souza', phone_number: '+5585988887777', 'qual_tratamento?': 'Depilação' }),
    lead('2131076834161303', { full_name: 'João da Silva', phone_number: '5511999999999' }),
    lead('2131076834161304', { full_name: 'Sem Telefone', email: 'a@b.com' }),
  ];
  await startApp({ LEADS_PAGE_ID: '555', LEADS_A_CADA_MINUTOS: '0' });
  try {
    const r = await app.leads.run();
    assert.deepEqual(r, { forms: 1, imported: 2, failed: 0 });
    const novo = revvyWrites.filter((w) => w.path === '/api/v1/contacts');
    assert.deepEqual(novo[0].body.custom_fields, { meta_lead_id: '2131076834161302' });
    // João já existia: o id do lead é gravado no contato dele antes de criar o card
    const upd = revvyWrites.find((w) => w.method === 'PUT');
    assert.equal(upd.path, '/api/v1/contacts/c1');
    assert.deepEqual(upd.body.custom_fields, { meta_lead_id: '2131076834161303' });
    const cards = revvyWrites.filter((w) => w.path === '/api/v1/deals/create');
    assert.equal(cards.length, 2);
    assert.deepEqual(cards[0].body.kanban, { sector_name: 'Comercial', column_name: 'Novo Lead' });
    assert.equal(cards[0].key, 'meta-lead-card-2131076834161302');
    assert.match(cards[0].body.notes[1], /qual_tratamento\?: Depilação/);
    assert.ok(revvyWrites.indexOf(upd) < revvyWrites.indexOf(cards[1]), 'campo gravado antes do card');

    revvyWrites = [];
    const again = await app.leads.run();
    assert.equal(again.imported, 0);
    assert.equal(revvyWrites.length, 0, 'não importa de novo');
    const s = await (await fetch(appUrl + '/status?token=adm')).text();
    assert.doesNotMatch(s, /Ana Souza|5585988887777/);
  } finally { await stopApp(); }
});

test('leads de formulário: token sem permissão não quebra o app', async () => {
  await startApp({ LEADS_PAGE_ID: '777', LEADS_A_CADA_MINUTOS: '0' });
  try {
    const r = await app.leads.run();
    assert.ok(r.error);
    assert.equal(revvyWrites.length, 0);
  } finally { await stopApp(); }
});

test('distribuição: card que foi para Em Atendimento sem dona também é distribuído', async () => {
  await startApp({ DISTRIBUIR_ATENDENTES: 'Ana:u-ana,Eli:u-eli', DISTRIBUIR_A_CADA_SEGUNDOS: '0' });
  try {
    await app.distributor.run();
    const at = (s) => new Date(Date.now() + 1000 + s * 1000).toISOString();
    deals = {
      pulou: { id: 'pulou', column: { id: 'col-atend' }, created_at: at(1), contact_id: 'ka', contact_phone: '5585990000001' },
      comDona: { id: 'comDona', column: { id: 'col-atend' }, assigned_user: { id: 'u-eli' }, created_at: at(2), contact_id: 'kb', contact_phone: '5585990000002' },
      normal: { id: 'normal', column_id: 'col-novo', created_at: at(3), contact_id: 'kc', contact_phone: '5585990000003' },
    };
    contacts.ka = { id: 'ka', conversations: [] }; contacts.kc = { id: 'kc', conversations: [] };
    await app.distributor.run({ now: Date.now() + 60_000 });
    const puts = revvyWrites.filter((w) => w.method === 'PUT');
    assert.deepEqual(puts.map((w) => [w.path, w.body.assigned_user_id]), [['/api/v1/deals/pulou', 'u-ana'], ['/api/v1/deals/normal', 'u-eli']]);
  } finally { await stopApp(); }
});

test('revvyTime e parseAttendants', () => {
  assert.equal(revvyTime('2026-10-10 00:38:18.989193-03'), Math.floor(Date.parse('2026-10-10T03:38:18.989Z') / 1000));
  assert.deepEqual(parseAttendants('Ana:u1, Eli:u2,Ruana:u3'), [{ nome: 'Ana', id: 'u1' }, { nome: 'Eli', id: 'u2' }, { nome: 'Ruana', id: 'u3' }]);
});

test('distribuição: rodízio exato, só negócios novos, contato que volta fica com a mesma atendente', async () => {
  await startApp({ DISTRIBUIR_ATENDENTES: 'Ana:u-ana,Eli:u-eli,Ruana:u-ruana', DISTRIBUIR_A_CADA_SEGUNDOS: '0' });
  try {
    deals = { velho: { id: 'velho', column_id: 'col-novo', created_at: ago(60), contact_id: 'cx' } };
    await app.distributor.run();
    assert.equal(revvyWrites.length, 0, 'o que já existia antes de ligar não é mexido');

    const novo = (id, contact, min = 0) => ({ id, column_id: 'col-novo', created_at: new Date(Date.now() + 1000 + min * 1000).toISOString(), contact_id: contact });
    deals.ig = { ...novo('ig', 'kig', 0.5), contact_phone: 'instagram:123' };
    for (let i = 0; i < 9; i++) { const d = { ...novo(`n${i}`, `k${i}`, i), contact_phone: `55859900000${i}` }; deals[d.id] = d; contacts[`k${i}`] = { id: `k${i}`, conversations: [{ id: `conv${i}`, status: 'open' }, { id: `old${i}`, status: 'closed' }] }; }
    deals.outra = { id: 'outra', column_id: 'col-vendido', created_at: new Date(Date.now() + 5000).toISOString(), contact_id: 'k0' };
    await app.distributor.run({ now: Date.now() + 60_000 });

    const puts = revvyWrites.filter((w) => w.method === 'PUT');
    assert.deepEqual(puts.map((w) => w.path), [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `/api/v1/deals/n${i}`), 'mais antigo primeiro, outra coluna e Instagram fora');
    assert.deepEqual(puts.map((w) => w.body.assigned_user_id), ['u-ana', 'u-eli', 'u-ruana', 'u-ana', 'u-eli', 'u-ruana', 'u-ana', 'u-eli', 'u-ruana']);
    const tr = revvyWrites.filter((w) => w.path === '/api/v1/conversations/transfer');
    assert.deepEqual(tr[0].body, { conversation_id: 'conv0', user_id: 'u-ana' });
    assert.equal(tr.length, 9, 'conversa encerrada não é transferida');
    assert.deepEqual(app.store.state.distribuicao.contagem, { Ana: 3, Eli: 3, Ruana: 3 });
    const tags = revvyWrites.filter((w) => w.path === '/api/v1/contacts/tags');
    assert.deepEqual(tags[0].body, { contact_id: 'k0', tag_ids: ['t-ana'] });
    assert.deepEqual(tags[1].body, { contact_id: 'k1', tag_ids: ['t-eli'] });
    assert.equal(tags.length, 9);

    // k1 (Eli) volta a falar: fica com a Eli e a vez continua na Ana
    revvyWrites = [];
    const v = { ...novo('volta', 'k1', 20), contact_phone: '558599000001' }; deals.volta = v;
    const n = { ...novo('n9', 'k9', 21), contact_phone: '558599000009' }; deals.n9 = n; contacts.k9 = { id: 'k9', conversations: [] };
    await app.distributor.run({ now: Date.now() + 120_000 });
    assert.deepEqual(revvyWrites.filter((w) => w.method === 'PUT').map((w) => w.body.assigned_user_id), ['u-eli', 'u-ana']);

    revvyWrites = [];
    await app.distributor.run({ now: Date.now() + 180_000 });
    assert.equal(revvyWrites.length, 0, 'não distribui de novo');
  } finally { await stopApp(); }
});

test('horário da distribuição', () => {
  const h = parseHours('seg-sex 08:00-18:00; sáb 08:00-12:00');
  const at = (iso) => Date.parse(iso); // horários em UTC; Fortaleza = UTC-3
  assert.equal(isOpen(h, at('2026-10-12T11:00:00Z')), true, 'segunda 8h');
  assert.equal(isOpen(h, at('2026-10-12T10:59:00Z')), false, 'segunda 7h59');
  assert.equal(isOpen(h, at('2026-10-12T21:00:00Z')), false, 'segunda 18h');
  assert.equal(isOpen(h, at('2026-10-10T14:30:00Z')), true, 'sábado 11h30');
  assert.equal(isOpen(h, at('2026-10-10T15:00:00Z')), false, 'sábado 12h');
  assert.equal(isOpen(h, at('2026-10-11T14:00:00Z')), false, 'domingo');
  assert.equal(isOpen([], at('2026-10-11T05:00:00Z')), true, 'sem horário = 24h');
  assert.throws(() => parseHours('segunda 8-18'));
});
