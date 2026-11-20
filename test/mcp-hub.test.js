import test from 'node:test';
import assert from 'node:assert/strict';
import { empresasDoAmbiente, loadHubConfig, parseMcpBody, createHubServer } from '../src/mcp-hub.js';

const TOKEN = 'x'.repeat(32);

/** MCP do Revvy de mentira: responde conforme a chave e registra as chamadas. */
function fakeRevvy({ sse = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    const auth = init.headers.Authorization || '';
    calls.push({ url, auth, body, sessao: init.headers['Mcp-Session-Id'] });
    const reply = (obj, extra = {}) => {
      const text = obj === null ? '' : sse ? `event: message\ndata: ${JSON.stringify(obj)}\n\n` : JSON.stringify(obj);
      return { status: obj === null ? 202 : 200, headers: new Map(Object.entries({ 'mcp-session-id': 'sess-' + auth.slice(-3), ...extra })), text: async () => text };
    };
    if (String(url).includes('/api/v1/')) {
      return { status: 200, headers: new Map(), text: async () => JSON.stringify({ ok: true, auth, method: init.method }) };
    }
    if (auth === 'Bearer ruim') return { status: 401, headers: new Map(), text: async () => 'no' };
    if (body.method === 'initialize') return reply({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', instructions: 'Você está conectado ao CRM revvy da empresa "X".\nChame get_workspace_overview antes.' } });
    if (body.method === 'notifications/initialized') return reply(null);
    if (body.method === 'tools/list') {
      return reply({ jsonrpc: '2.0', id: body.id, result: { tools: [
        { name: 'list_deals', description: 'Lista negócios', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, required: [] } },
        { name: 'get_workspace_overview', description: 'Visão geral', inputSchema: { type: 'object', properties: {} } },
      ] } });
    }
    if (body.method === 'tools/call') {
      return reply({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `${body.params.name} ${JSON.stringify(body.params.arguments)} via ${auth}` }] } });
    }
    return reply({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'x' } });
  };
  return { calls, fetchImpl };
}

async function start(env, revvy) {
  const cfg = loadHubConfig({ MCP_TOKEN: TOKEN, PORT: 0, REVVY_BASE_URL: 'https://crm.test', ...env });
  const { server } = createHubServer(cfg, { fetchImpl: revvy.fetchImpl, logger: { error() {}, log() {} } });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let id = 1;
  const rpc = async (method, params, token = TOKEN) => {
    const res = await fetch(`${base}/mcp/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) });
    return { status: res.status, body: res.status === 202 ? null : await res.json() };
  };
  return { server, base, rpc };
}

test('empresas vêm de REVVY_KEY_<NOME> e ignoram vazias', () => {
  const e = empresasDoAmbiente({ REVVY_KEY_TERESINA: 'b', REVVY_KEY_FORTALEZA: 'a', REVVY_KEY_VAZIA: ' ', OUTRA: 'c' });
  assert.deepEqual(e, [{ nome: 'fortaleza', chave: 'a' }, { nome: 'teresina', chave: 'b' }]);
});

test('parseMcpBody lê JSON e SSE', () => {
  assert.equal(parseMcpBody('{"jsonrpc":"2.0","id":3,"result":{"a":1}}', 3).result.a, 1);
  assert.equal(parseMcpBody('event: message\ndata: {"jsonrpc":"2.0","id":4,"result":{"b":2}}\n\n', 4).result.b, 2);
});

test('token errado é recusado', async () => {
  const { server, rpc } = await start({ REVVY_KEY_FORTALEZA: 'k-for' }, fakeRevvy());
  try {
    const r = await rpc('tools/list', {}, 'y'.repeat(32));
    assert.equal(r.status, 401);
  } finally { server.close(); }
});

for (const sse of [false, true]) {
  test(`repassa ferramentas do Revvy com "empresa" e usa a chave certa (${sse ? 'SSE' : 'JSON'})`, async () => {
    const revvy = fakeRevvy({ sse });
    const { server, rpc } = await start({ REVVY_KEY_FORTALEZA: 'k-for', REVVY_KEY_TERESINA: 'k-ter' }, revvy);
    try {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
      assert.match(init.body.result.instructions, /fortaleza, teresina/);
      assert.match(init.body.result.instructions, /get_workspace_overview/);
      assert.doesNotMatch(init.body.result.instructions, /da empresa "X"/);

      const list = await rpc('tools/list', {});
      const names = list.body.result.tools.map((t) => t.name);
      assert.deepEqual(names, ['listar_empresas', 'api_revvy', 'list_deals', 'get_workspace_overview']);
      const deals = list.body.result.tools.find((t) => t.name === 'list_deals');
      assert.deepEqual(deals.inputSchema.properties.empresa.enum, ['fortaleza', 'teresina']);
      assert.deepEqual(deals.inputSchema.required, ['empresa']);

      const r = await rpc('tools/call', { name: 'list_deals', arguments: { empresa: 'teresina', limit: 5 } });
      assert.equal(r.body.result.content[0].text, 'list_deals {"limit":5} via Bearer k-ter');
      const r2 = await rpc('tools/call', { name: 'list_deals', arguments: { empresa: 'Fortaleza' } });
      assert.equal(r2.body.result.content[0].text, 'list_deals {} via Bearer k-for');
      // sessão do Revvy reaproveitada por empresa
      const ter = revvy.calls.filter((c) => c.auth === 'Bearer k-ter' && c.body?.method === 'tools/call');
      assert.equal(ter[0].sessao, 'sess-ter');
    } finally { server.close(); }
  });
}

test('empresa desconhecida vira erro legível', async () => {
  const { server, rpc } = await start({ REVVY_KEY_FORTALEZA: 'k-for' }, fakeRevvy());
  try {
    const r = await rpc('tools/call', { name: 'list_deals', arguments: { empresa: 'manaus' } });
    assert.equal(r.body.result.isError, true);
    assert.match(r.body.result.content[0].text, /Disponíveis: fortaleza/);
  } finally { server.close(); }
});

test('api_revvy lê livre e só escreve com confirmar=true', async () => {
  const { server, rpc } = await start({ REVVY_KEY_FORTALEZA: 'k-for' }, fakeRevvy());
  try {
    const get = await rpc('tools/call', { name: 'api_revvy', arguments: { empresa: 'fortaleza', caminho: '/api/v1/deals?limit=1' } });
    assert.match(get.body.result.content[0].text, /HTTP 200 \(empresa fortaleza\)[\s\S]*Bearer k-for/);
    const semConfirmar = await rpc('tools/call', { name: 'api_revvy', arguments: { empresa: 'fortaleza', metodo: 'POST', caminho: '/api/v1/tags', corpo: { name: 'x' } } });
    assert.equal(semConfirmar.body.result.isError, true);
    const ok = await rpc('tools/call', { name: 'api_revvy', arguments: { empresa: 'fortaleza', metodo: 'POST', caminho: '/api/v1/tags', corpo: { name: 'x' }, confirmar: true } });
    assert.match(ok.body.result.content[0].text, /"method":"POST"/);
  } finally { server.close(); }
});

test('chave recusada pelo Revvy: segue com as ferramentas próprias', async () => {
  const { server, rpc } = await start({ REVVY_KEY_RUIM: 'ruim' }, fakeRevvy());
  try {
    const list = await rpc('tools/list', {});
    assert.deepEqual(list.body.result.tools.map((t) => t.name), ['listar_empresas', 'api_revvy']);
  } finally { server.close(); }
});

test('notificação devolve 202 e chave no link quando REVVY_MCP_CHAVE=query:api_key', async () => {
  const revvy = fakeRevvy();
  const { server, rpc } = await start({ REVVY_KEY_FORTALEZA: 'k-for', REVVY_MCP_CHAVE: 'query:api_key' }, revvy);
  try {
    const n = await fetch(server.address() && `http://127.0.0.1:${server.address().port}/mcp/${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.equal(n.status, 202);
    await rpc('tools/list', {});
    assert.match(revvy.calls[0].url, /api_key=k-for/);
    assert.equal(revvy.calls[0].auth, '');
  } finally { server.close(); }
});
