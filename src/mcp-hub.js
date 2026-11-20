/**
 * Conector MCP único para todas as empresas do Revvy.
 *
 * O Claude conecta em POST /mcp/<MCP_TOKEN>. Cada empresa entra só com uma variável de ambiente
 * REVVY_KEY_<NOME>=<chave de API da empresa>. As ferramentas do MCP do Revvy são repassadas com um
 * campo extra "empresa", e a chamada vai para o Revvy com a chave daquela empresa.
 * Também há ferramentas próprias: listar_empresas e api_revvy (API REST /api/v1, que usa a mesma chave).
 */
import http from 'node:http';
import crypto from 'node:crypto';

const PROTOCOL = '2025-06-18';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lê as empresas do ambiente: REVVY_KEY_FORTALEZA=..., REVVY_KEY_ICE_LASER_TERESINA=... */
export function empresasDoAmbiente(env = process.env) {
  const out = [];
  for (const [k, v] of Object.entries(env)) {
    const m = k.match(/^REVVY_KEY_([A-Z0-9_]+)$/i);
    if (!m || !String(v || '').trim()) continue;
    out.push({ nome: m[1].toLowerCase(), chave: String(v).trim() });
  }
  return out.sort((a, b) => a.nome.localeCompare(b.nome));
}

export function loadHubConfig(env = process.env) {
  const base = String(env.REVVY_BASE_URL || 'https://app.crmrevvy.com.br').replace(/\/+$/, '');
  return {
    port: Number(env.PORT || 3000),
    token: String(env.MCP_TOKEN || '').trim(),
    revvyBase: base,
    // Endereço do MCP do Revvy. A chave vai no cabeçalho Authorization: Bearer (REVVY_MCP_CHAVE=bearer)
    // ou como parâmetro no link (REVVY_MCP_CHAVE=query:<nome do parâmetro>).
    revvyMcpUrl: String(env.REVVY_MCP_URL || `${base}/mcp`).trim(),
    revvyMcpChave: String(env.REVVY_MCP_CHAVE || 'bearer').trim(),
    empresas: empresasDoAmbiente(env),
  };
}

/** Lê a resposta do MCP do Revvy: JSON puro ou SSE (linhas "data: {...}"). */
export function parseMcpBody(text, id) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (t.startsWith('{') || t.startsWith('[')) {
    const j = JSON.parse(t);
    return Array.isArray(j) ? j.find((m) => m.id === id) || j[0] : j;
  }
  let found = null;
  for (const line of t.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    try {
      const m = JSON.parse(line.slice(5).trim());
      if (m && (m.id === id || (!found && ('result' in m || 'error' in m)))) found = m;
    } catch { /* linha que não é JSON */ }
  }
  return found;
}

/** Cliente MCP (HTTP) para o servidor do Revvy, uma sessão por empresa. */
export class RevvyMcpClient {
  constructor({ url, modoChave, chave }, { fetchImpl = fetch } = {}) {
    this.modoChave = modoChave;
    this.chave = chave;
    this.fetch = fetchImpl;
    this.sessao = null;
    this.nextId = 1;
    const u = new URL(url);
    if (modoChave.startsWith('query:')) u.searchParams.set(modoChave.slice(6), chave);
    this.url = u.toString();
    this.instructions = '';
  }

  headers() {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL };
    if (this.modoChave === 'bearer') h.Authorization = `Bearer ${this.chave}`;
    if (this.sessao) h['Mcp-Session-Id'] = this.sessao;
    return h;
  }

  async post(msg) {
    const res = await this.fetch(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(msg) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessao = sid;
    const text = await res.text();
    return { status: res.status, text };
  }

  async iniciar() {
    this.sessao = null;
    const id = this.nextId++;
    const r = await this.post({
      jsonrpc: '2.0', id, method: 'initialize',
      params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'revvy-hub', version: '1.0.0' } },
    });
    if (r.status === 401 || r.status === 403) throw new Error(`o MCP do Revvy recusou a chave (HTTP ${r.status})`);
    if (r.status >= 400) throw new Error(`o MCP do Revvy respondeu HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    const msg = parseMcpBody(r.text, id);
    if (!msg || msg.error) throw new Error(`initialize falhou: ${JSON.stringify(msg?.error || r.text.slice(0, 200))}`);
    this.instructions = msg.result?.instructions || '';
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this.iniciado = true;
    return msg.result;
  }

  async chamar(method, params, tentativa = 0) {
    if (!this.iniciado) await this.iniciar();
    const id = this.nextId++;
    const r = await this.post({ jsonrpc: '2.0', id, method, params });
    // Sessão expirada: o servidor devolve 404/400; abre outra e tenta uma vez
    if ((r.status === 404 || r.status === 400) && tentativa === 0 && this.sessao) {
      this.iniciado = false;
      return this.chamar(method, params, 1);
    }
    if (r.status === 429 && tentativa < 3) { await sleep(2000 * (tentativa + 1)); return this.chamar(method, params, tentativa + 1); }
    if (r.status >= 400) throw new Error(`o MCP do Revvy respondeu HTTP ${r.status}: ${r.text.slice(0, 300)}`);
    const msg = parseMcpBody(r.text, id);
    if (!msg) throw new Error('resposta vazia do MCP do Revvy');
    if (msg.error) { const e = new Error(msg.error.message || 'erro do MCP do Revvy'); e.rpc = msg.error; throw e; }
    return msg.result;
  }
}

const EMPRESA_DESC = 'Empresa do Revvy em que a ação acontece (veja listar_empresas). Se o usuário não disse, pergunte antes de agir.';

function comEmpresa(tool, nomes) {
  const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? structuredClone(tool.inputSchema) : { type: 'object' };
  schema.type = 'object';
  schema.properties = { empresa: { type: 'string', enum: nomes, description: EMPRESA_DESC }, ...(schema.properties || {}) };
  schema.required = ['empresa', ...((schema.required || []).filter((r) => r !== 'empresa'))];
  return { ...tool, inputSchema: schema };
}

export class Hub {
  constructor(cfg, { fetchImpl = fetch, logger = console } = {}) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.clientes = new Map();
    this.cacheFerramentas = null;
    this.instructions = '';
  }

  nomes() { return this.cfg.empresas.map((e) => e.nome); }

  empresa(nome) {
    const n = String(nome || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const e = this.cfg.empresas.find((x) => x.nome === n) || this.cfg.empresas.find((x) => x.nome.includes(n) && n);
    if (!e) throw new Error(`empresa "${nome}" não encontrada. Disponíveis: ${this.nomes().join(', ') || 'nenhuma (crie REVVY_KEY_<NOME> no Environment)'}`);
    return e;
  }

  cliente(e) {
    if (!this.clientes.has(e.nome)) {
      this.clientes.set(e.nome, new RevvyMcpClient({ url: this.cfg.revvyMcpUrl, modoChave: this.cfg.revvyMcpChave, chave: e.chave }, { fetchImpl: this.fetch }));
    }
    return this.clientes.get(e.nome);
  }

  ferramentasProprias() {
    const nomes = this.nomes();
    return [
      {
        name: 'listar_empresas',
        description: 'Lista as empresas do Revvy que este conector alcança. Use primeiro e passe o nome em "empresa" nas outras ferramentas.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'api_revvy',
        description: 'Chama a API REST do Revvy (/api/v1/...) de uma empresa. Útil quando nenhuma outra ferramenta cobre o caso. '
          + 'Leitura (GET) é livre; POST/PUT/DELETE muda dados de verdade: só use com confirmar=true depois que o usuário confirmar a ação.',
        inputSchema: {
          type: 'object',
          properties: {
            empresa: { type: 'string', enum: nomes, description: EMPRESA_DESC },
            metodo: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'Padrão GET' },
            caminho: { type: 'string', description: 'Ex.: /api/v1/deals?column_id=...&limit=50' },
            corpo: { type: 'object', description: 'Corpo JSON para POST/PUT' },
            confirmar: { type: 'boolean', description: 'Obrigatório true para POST/PUT/DELETE' },
          },
          required: ['empresa', 'caminho'],
        },
      },
    ];
  }

  async ferramentas() {
    const proprias = this.ferramentasProprias();
    if (!this.cfg.empresas.length) return proprias;
    if (this.cacheFerramentas && Date.now() - this.cacheFerramentas.em < 10 * 60_000) return [...proprias, ...this.cacheFerramentas.lista];
    // A lista vem do MCP do Revvy; tenta as empresas em ordem até uma responder
    let ultimoErro;
    for (const e of this.cfg.empresas) {
      try {
        const c = this.cliente(e);
        const lista = [];
        let cursor;
        do {
          const r = await c.chamar('tools/list', cursor ? { cursor } : {});
          lista.push(...(r.tools || []));
          cursor = r.nextCursor;
        } while (cursor);
        this.instructions = c.instructions;
        const usados = new Set(proprias.map((t) => t.name));
        const repassadas = lista.filter((t) => !usados.has(t.name)).map((t) => comEmpresa(t, this.nomes()));
        this.cacheFerramentas = { em: Date.now(), lista: repassadas };
        return [...proprias, ...repassadas];
      } catch (err) {
        ultimoErro = err;
        this.logger.error(`[mcp] não consegui listar as ferramentas do Revvy com a chave de "${e.nome}": ${err.message}`);
      }
    }
    this.logger.error(`[mcp] seguindo só com as ferramentas próprias: ${ultimoErro?.message}`);
    return proprias;
  }

  async apiRevvy(args) {
    const e = this.empresa(args.empresa);
    const metodo = String(args.metodo || 'GET').toUpperCase();
    const caminho = String(args.caminho || '');
    if (!caminho.startsWith('/api/')) throw new Error('caminho precisa começar com /api/ (ex.: /api/v1/deals)');
    if (metodo !== 'GET' && args.confirmar !== true) throw new Error(`${metodo} muda dados no Revvy: confirme com o usuário e chame de novo com confirmar=true`);
    const headers = { Authorization: `Bearer ${e.chave}`, Accept: 'application/json' };
    const init = { method: metodo, headers };
    if (args.corpo && metodo !== 'GET') {
      headers['Content-Type'] = 'application/json';
      headers['Idempotency-Key'] = crypto.createHash('sha256').update(`${e.nome}:${metodo}:${caminho}:${JSON.stringify(args.corpo)}`).digest('hex').slice(0, 40);
      init.body = JSON.stringify(args.corpo);
    }
    const res = await this.fetch(this.cfg.revvyBase + caminho, init);
    const text = await res.text();
    return `HTTP ${res.status} (empresa ${e.nome})\n${text.slice(0, 60_000)}`;
  }

  async chamarFerramenta(name, args = {}) {
    const texto = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
    try {
      if (name === 'listar_empresas') {
        return texto(JSON.stringify({ empresas: this.nomes(), como_usar: 'passe o nome em "empresa" em qualquer outra ferramenta' }, null, 2));
      }
      if (name === 'api_revvy') return texto(await this.apiRevvy(args));
      const { empresa, ...resto } = args || {};
      const e = this.empresa(empresa);
      const r = await this.cliente(e).chamar('tools/call', { name, arguments: resto });
      return r;
    } catch (err) {
      return texto(`Erro: ${err.message}`, true);
    }
  }

  instrucoes() {
    const base = `Conector único do Revvy para várias empresas: ${this.nomes().join(', ') || '(nenhuma configurada)'}. `
      + 'Toda ferramenta recebe "empresa". Quando o usuário pedir para focar numa empresa, use essa empresa até ele mudar. '
      + 'Nunca misture dados de empresas diferentes sem deixar claro de qual é cada número.';
    // As instruções do Revvy citam a empresa da chave usada para listar; aqui valem para todas
    const regras = this.instructions.split('\n').filter((l) => !/^\s*Você está conectado ao CRM/i.test(l)).join('\n').trim();
    return regras ? `${base}\n\nRegras do Revvy (valem para todas as empresas):\n${regras}` : base;
  }

  /** Atende uma mensagem JSON-RPC. Devolve a resposta ou null (notificação). */
  async handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'requisição inválida' } };
    }
    if (msg.id === undefined || msg.id === null) return null; // notificação
    const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'initialize':
        // Lista as ferramentas já aqui para trazer as instruções do Revvy junto
        await this.ferramentas().catch(() => {});
        return ok({
          protocolVersion: msg.params?.protocolVersion || PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'revvy-todas-empresas', version: '1.0.0' },
          instructions: this.instrucoes(),
        });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: await this.ferramentas() });
      case 'tools/call':
        return ok(await this.chamarFerramenta(msg.params?.name, msg.params?.arguments || {}));
      default:
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `método não suportado: ${msg.method}` } };
    }
  }
}

function tokenOk(got, want) {
  if (!want || !got) return false;
  const a = Buffer.from(String(got));
  const b = Buffer.from(String(want));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createHubServer(cfg, opts = {}) {
  const hub = new Hub(cfg, opts);
  const logger = opts.logger || console;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const send = (status, obj, extra = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra });
      res.end(obj === undefined ? '' : JSON.stringify(obj));
    };
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return send(200, { ok: true, modo: 'mcp', empresas: hub.nomes(), token_configurado: Boolean(cfg.token) });
    }
    const m = url.pathname.match(/^\/mcp\/([^/]+)\/?$/);
    if (!m) return send(404, { erro: 'não encontrado' });
    if (!tokenOk(decodeURIComponent(m[1]), cfg.token)) return send(401, { erro: 'token inválido' });
    if (req.method === 'GET') return send(405, { erro: 'use POST' }, { Allow: 'POST, DELETE' });
    if (req.method === 'DELETE') return send(200, {});
    if (req.method !== 'POST') return send(405, { erro: 'use POST' });

    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body;
    try { body = JSON.parse(raw); } catch { return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } }); }
    try {
      if (Array.isArray(body)) {
        const out = (await Promise.all(body.map((b) => hub.handle(b)))).filter(Boolean);
        return out.length ? send(200, out) : send(202);
      }
      const out = await hub.handle(body);
      return out ? send(200, out) : send(202);
    } catch (err) {
      logger.error(`[mcp] erro: ${err.message}`);
      return send(500, { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32603, message: err.message } });
    }
  });
  return { server, hub };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadHubConfig();
  if (!cfg.token || cfg.token.length < 24) {
    console.error('MCP_TOKEN faltando ou curto demais (mínimo 24 caracteres). Gere um aleatório e coloque no Environment.');
    process.exit(1);
  }
  const { server } = createHubServer(cfg);
  server.listen(cfg.port, () => {
    console.log(`[mcp] conector único ouvindo na porta ${cfg.port}, endereço /mcp/<MCP_TOKEN>`);
    console.log(`[mcp] empresas: ${cfg.empresas.map((e) => e.nome).join(', ') || 'nenhuma (crie REVVY_KEY_<NOME> no Environment)'}`);
    console.log(`[mcp] MCP do Revvy: ${cfg.revvyMcpUrl} (chave via ${cfg.revvyMcpChave})`);
  });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
}
