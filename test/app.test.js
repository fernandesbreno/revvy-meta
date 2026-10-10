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

const SECRET = 'segredo-teste';
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const quiet = { log() {}, warn() {}, error() {} };

// ---- Revvy + Meta simulados ----
let metaCalls = [];
let metaFail = 0;
let deals = {};
let contacts = {};
let histories = {};
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
      let m;
      if ((m = u.pathname.match(/^\/api\/v1\/deals\/([^/]+)\/stage-history$/))) return send(200, { success: true, data: { history: histories[m[1]] || [] } });
      if ((m = u.pathname.match(/^\/api\/v1\/deals\/([^/]+)$/))) return deals[m[1]] ? send(200, { success: true, data: deals[m[1]] }) : send(404, {});
      if (u.pathname === '/api/v1/deals') return send(200, { success: true, data: Object.values(deals), pagination: { has_more: false } });
      if ((m = u.pathname.match(/^\/api\/v1\/contacts\/([^/]+)$/))) return contacts[m[1]] ? send(200, { success: true, data: contacts[m[1]] }) : send(404, {});
      if (u.pathname.startsWith('/graph/')) {
        if (metaFail > 0) { metaFail--; return send(500, { error: 'temporário' }); }
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
  metaCalls = []; metaFail = 0;
  deals = { d1: { id: 'd1', value: 2500, created_at: ago(120), contact: { id: 'c1', name: 'João da Silva', phone: '5511999999999', email: 'Joao@Exemplo.com' }, column: { name: 'Venda Concluída' } } };
  contacts = { c1: { id: 'c1', name: 'João da Silva', phone: '5511999999999', email: 'Joao@Exemplo.com', city: 'São Paulo', custom_fields: { meta_lead_id: '1234567890123456' } } };
  histories = {};
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
    assert.match(JSON.stringify(app.store.state.log.at(-1)), /INSTAGRAM_BUSINESS_ACCOUNT_ID/);
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

test('modo teste envia test_event_code e não marca como enviado', async () => {
  await startApp({ META_TEST_EVENT_CODE: 'TEST123', PREENCHER_ETAPAS_PULADAS: 'false' });
  try {
    await signedPost({ data: { deal_id: 'd1', to_column: { name: 'Venda Concluída' } } });
    await settle();
    await signedPost({ data: { deal_id: 'd1', to_column: { name: 'Venda Concluída' } } });
    await settle();
    assert.equal(metaCalls.length, 2);
    assert.equal(metaCalls[0].body.test_event_code, 'TEST123');
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
