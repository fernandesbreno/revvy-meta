import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseAttendants, parseHours } from './distribuidor.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function normalize(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function loadStages(env) {
  const raw = env.ETAPAS_JSON || readFileSync(env.ETAPAS_FILE || path.join(root, 'etapas.json'), 'utf8');
  const list = JSON.parse(raw).etapas;
  if (!Array.isArray(list) || !list.length) throw new Error('etapas.json sem a lista "etapas"');
  return list.map((e, i) => ({ ...e, key: normalize(e.coluna), aliases: (e.apelidos || []).map(normalize), ordem: i }));
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
      apiKey: String(env.REVVY_API_KEY).trim(),
      webhookSecret: env.REVVY_WEBHOOK_SECRET,
      // o webhook de mensagens pode ser outro, com secret próprio
      extraSecrets: [env.REVVY_WEBHOOK_SECRET_MENSAGENS].filter(Boolean),
      validateSignature: env.VALIDAR_ASSINATURA !== 'false',
    },
    meta: {
      graphUrl: (env.META_GRAPH_URL || 'https://graph.facebook.com').replace(/\/$/, ''),
      graphVersion: env.META_GRAPH_VERSION || 'v24.0',
      datasetId: env.META_DATASET_ID,
      accessToken: String(env.META_ACCESS_TOKEN).trim(),
      wabaId: env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
      igAccountId: env.INSTAGRAM_BUSINESS_ACCOUNT_ID || '',
      igDatasetId: env.META_DATASET_ID_INSTAGRAM || '',
      pageId: env.FACEBOOK_PAGE_ID || '',
      pageDatasetId: env.META_DATASET_ID_MESSENGER || '',
      waDatasetId: env.META_DATASET_ID_WHATSAPP || '',
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
    leads: {
      pageId: String(env.LEADS_PAGE_ID || '').trim(),
      token: String(env.META_LEADS_TOKEN || env.META_ACCESS_TOKEN).trim(),
      intervalMinutes: Number(env.LEADS_A_CADA_MINUTOS ?? 2),
      daysBack: Number(env.LEADS_DIAS_ATRAS || 0),
      sector: env.LEADS_SETOR || 'Comercial',
      column: env.LEADS_COLUNA || 'Novo Lead',
    },
    distribuir: {
      atendentes: parseAttendants(env.DISTRIBUIR_ATENDENTES),
      intervalSeconds: Number(env.DISTRIBUIR_A_CADA_SEGUNDOS ?? 20),
      column: env.DISTRIBUIR_COLUNA || 'Novo Lead',
      columnId: env.DISTRIBUIR_COLUNA_ID || '',
      // colunas para onde o card pode ir antes de ganhar dona (ex.: automação "Em Atendimento" quando o lead responde rápido)
      colunasSemDona: String(env.DISTRIBUIR_COLUNAS_SEM_DONA ?? 'Em Atendimento').split(',').map((c) => c.trim()).filter(Boolean),
      etiquetas: env.DISTRIBUIR_ETIQUETAS !== 'false',
      soWhatsapp: env.DISTRIBUIR_SO_WHATSAPP !== 'false',
      // contatos com estas etiquetas (ex.: cliente que já comprou) não são distribuídos nem saudados
      // etiqueta posta antes de atribuir quando a atendente já abordou o lead pelo celular; o workflow de saudação pula quem a tem
      etiquetaAbordado: String(env.DISTRIBUIR_ETIQUETA_ABORDADO ?? 'Abordado').trim(),
      ignorarEtiquetas: String(env.DISTRIBUIR_IGNORAR_ETIQUETAS ?? 'Pago').split(',').map((t) => t.trim()).filter(Boolean),
      horario: parseHours(env.DISTRIBUIR_HORARIO),
      horarioTexto: env.DISTRIBUIR_HORARIO || '24 horas',
    },
    audios: {
      ligado: env.TRANSCREVER_AUDIOS_EQUIPE === 'true',
      apiKey: String(env.OPENAI_API_KEY || '').trim(),
      apiUrl: (env.TRANSCRICAO_API_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
      modelo: env.TRANSCRICAO_MODELO || 'gpt-4o-mini-transcribe',
      // grava a nota no nome de quem mandou o áudio, quando o webhook diz quem foi
      autorDaNota: env.TRANSCRICAO_AUTOR_DA_NOTA !== 'false',
      // áudios mandados pelo celular chegam pelo webhook da Meta (/webhooks/whatsapp)
      whatsappToken: String(env.WHATSAPP_TOKEN || env.META_ACCESS_TOKEN || '').trim(),
      appSecret: String(env.META_APP_SECRET || '').trim(),
      verifyToken: String(env.WHATSAPP_VERIFY_TOKEN || '').trim(),
      graphUrl: (env.META_GRAPH_URL || 'https://graph.facebook.com').replace(/\/$/, ''),
      graphVersion: env.META_GRAPH_VERSION || 'v24.0',
    },
    recepcao: {
      // mensagem de confirmação da sessão enviada pela equipe → card do cliente vai para a Recepção
      ligado: env.CONFIRMACAO_RECEPCAO === 'true',
      frases: String(env.CONFIRMACAO_FRASES ?? 'confirmar sua sessao|confirmar a sua sessao').split('|').map((f) => f.trim()).filter(Boolean),
      coluna: env.RECEPCAO_COLUNA || 'Recepção',
      etiqueta: String(env.RECEPCAO_ETIQUETA ?? 'Cliente - Recepção').trim(),
    },
    privacidade: {
      empresa: env.EMPRESA_NOME || 'Ice Laser',
      contato: env.PRIVACIDADE_CONTATO || '',
    },
    fillSkippedStages: env.PREENCHER_ETAPAS_PULADAS !== 'false',
    stages: loadStages(env),
  };
}
