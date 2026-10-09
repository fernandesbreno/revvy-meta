import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function normalize(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function loadStages(env) {
  const raw = env.ETAPAS_JSON || readFileSync(env.ETAPAS_FILE || path.join(root, 'etapas.json'), 'utf8');
  const list = JSON.parse(raw).etapas;
  if (!Array.isArray(list) || !list.length) throw new Error('etapas.json sem a lista "etapas"');
  return list.map((e, i) => ({ ...e, key: normalize(e.coluna), ordem: i }));
}

export function loadConfig(env = process.env) {
  const required = ['REVVY_API_KEY', 'REVVY_WEBHOOK_SECRET', 'META_DATASET_ID', 'META_ACCESS_TOKEN'];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error(`Variáveis de ambiente faltando: ${missing.join(', ')}`);

  return {
    port: Number(env.PORT || 3000),
    dataDir: env.DATA_DIR || '/data',
    adminToken: env.ADMIN_TOKEN || '',
    revvy: {
      baseUrl: (env.REVVY_BASE_URL || 'https://revvy.uni6.net').replace(/\/$/, ''),
      apiKey: env.REVVY_API_KEY,
      webhookSecret: env.REVVY_WEBHOOK_SECRET,
      validateSignature: env.VALIDAR_ASSINATURA !== 'false',
    },
    meta: {
      graphUrl: (env.META_GRAPH_URL || 'https://graph.facebook.com').replace(/\/$/, ''),
      graphVersion: env.META_GRAPH_VERSION || 'v24.0',
      datasetId: env.META_DATASET_ID,
      accessToken: env.META_ACCESS_TOKEN,
      wabaId: env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
      testEventCode: env.META_TEST_EVENT_CODE || '',
      leadEventSource: env.LEAD_EVENT_SOURCE || 'Revvy',
      currency: env.MOEDA || 'BRL',
      retryBaseMs: Number(env.META_RETRY_BASE_MS || 2000),
    },
    fields: {
      metaLeadId: env.CAMPO_META_LEAD_ID || 'meta_lead_id',
      ctwaClid: env.CAMPO_CTWA_CLID || 'ctwa_clid',
      fbc: env.CAMPO_FBC || 'fbc',
      fbp: env.CAMPO_FBP || 'fbp',
    },
    reconcile: {
      intervalMinutes: Number(env.RECONCILIAR_A_CADA_MINUTOS ?? 60),
      days: Number(env.RECONCILIAR_DIAS || 30),
    },
    fillSkippedStages: env.PREENCHER_ETAPAS_PULADAS !== 'false',
    stages: loadStages(env),
  };
}
