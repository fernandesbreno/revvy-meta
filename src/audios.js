import { agoraBr } from './store.js';

/**
 * Transcreve os áudios que a equipe manda no WhatsApp e grava o texto como nota interna da conversa.
 * O Revvy já transcreve os áudios do cliente, mas não os da atendente, e a API não entrega o arquivo;
 * quem entrega é o webhook "Nova mensagem enviada". O formato desse payload não está documentado,
 * então procuramos os campos em vários lugares prováveis e guardamos os últimos exemplos em /audios
 * para conferir quando algo não for reconhecido.
 */

const get = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function first(body, paths) {
  for (const p of paths) {
    const v = get(body, p);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}
const prefixed = (paths) => paths.flatMap((p) => [p, `data.${p}`, `payload.${p}`, `message.${p}`, `data.message.${p}`, `payload.message.${p}`]);

const EVENT = ['event', 'type', 'event_type', 'action', 'evento', 'data.event'];
const MESSAGE_ID = prefixed(['message_id', 'messageId', 'wa_message_id']).concat(['message.id', 'data.message.id', 'payload.message.id', 'data.id', 'id']);
const CONVERSATION_ID = prefixed(['conversation_id', 'conversationId', 'conversation.id', 'chat_id']);
const FROM_ME = prefixed(['from_me', 'fromMe', 'is_from_me', 'outgoing', 'direction', 'sender_type']);
const TYPE = prefixed(['message_type', 'messageType', 'media_type', 'mediaType', 'type', 'mimetype', 'mime_type']);
const MEDIA_URL = prefixed(['media_url', 'mediaUrl', 'file_url', 'fileUrl', 'audio_url', 'audioUrl', 'url', 'media.url', 'audio.url', 'file.url', 'attachment.url', 'attachments.0.url', 'media.link', 'audio.link']);
const BASE64 = prefixed(['base64', 'media_base64', 'media.base64', 'audio.base64', 'file.base64']);
const MIME = prefixed(['mimetype', 'mime_type', 'mimeType', 'media.mimetype', 'media.mime_type', 'audio.mimetype', 'file.mimetype']);
const USER_ID = prefixed(['user_id', 'sender_id', 'sender_user_id', 'agent_id', 'sender.id', 'user.id']);
const SENDER_NAME = prefixed(['sender_name', 'user_name', 'agent_name', 'sender.name', 'user.name']);
const AT = prefixed(['created_at', 'sent_at', 'timestamp', 'at']);

/** O webhook é de mensagem (e não de card)? */
export function isMessageWebhook(body) {
  const evento = String(first(body || {}, EVENT) || '');
  if (/message|mensag/i.test(evento)) return true;
  return first(body || {}, FROM_ME) !== undefined && first(body || {}, CONVERSATION_ID) !== undefined;
}

function truthyFromMe(v) {
  if (typeof v === 'boolean') return v;
  return /^(true|1|out|outgoing|outbound|sent|agent|user|me)$/i.test(String(v ?? '').trim());
}

export function parseMessageWebhook(body) {
  body = body || {};
  const evento = String(first(body, EVENT) || '');
  const fromMeRaw = first(body, FROM_ME);
  const tipo = String(first(body, TYPE) || '');
  const mediaUrl = first(body, MEDIA_URL);
  const base64 = first(body, BASE64);
  const mime = first(body, MIME);
  return {
    evento,
    messageId: first(body, MESSAGE_ID) ? String(first(body, MESSAGE_ID)) : null,
    conversationId: first(body, CONVERSATION_ID) ? String(first(body, CONVERSATION_ID)) : null,
    // "Nova mensagem enviada" é sempre da empresa, mesmo quando o payload não diz from_me
    fromMe: fromMeRaw !== undefined ? truthyFromMe(fromMeRaw) : /sent|enviad|outgoing/i.test(evento),
    isAudio: /audio|ptt|voice|ogg|opus/i.test(`${tipo} ${mime || ''}`),
    mediaUrl: typeof mediaUrl === 'string' && /^https?:\/\//i.test(mediaUrl) ? mediaUrl : null,
    base64: typeof base64 === 'string' && base64.length > 100 ? base64.replace(/^data:[^,]*,/, '') : null,
    mime: mime ? String(mime) : null,
    userId: first(body, USER_ID) ? String(first(body, USER_ID)) : null,
    senderName: first(body, SENDER_NAME) ? String(first(body, SENDER_NAME)) : null,
    at: first(body, AT) || null,
  };
}

/** Cópia do payload sem textos longos (base64), para mostrar em /audios. */
function sample(body) {
  return JSON.parse(JSON.stringify(body, (k, v) => (typeof v === 'string' && v.length > 300 ? `${v.slice(0, 80)}… (${v.length} caracteres)` : v)));
}

function hourBr(at) {
  const d = at ? new Date(String(at).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - 3 * 3600_000).toISOString().slice(11, 16);
}

const RETRY_DELAYS_S = [30, 120, 600];

export class AudioTranscriber {
  constructor({ cfg, store, revvy, fetchImpl = fetch, logger = console }) {
    Object.assign(this, { cfg: cfg.audios, revvyCfg: cfg.revvy, store, revvy, fetch: fetchImpl, logger });
    this.timers = new Set();
    // áudios que estavam na fila quando o app reiniciou (Deploy) voltam a ser transcritos
    for (const [key, m] of Object.entries(this.st.fila)) this.schedule({ key, m, attempts: 0 }, 5_000);
  }

  get st() {
    const st = (this.store.state.audios ||= { feitos: {}, amostras: [], log: [] });
    st.fila ||= {};
    return st;
  }

  get ligado() { return Boolean(this.cfg.ligado && this.cfg.apiKey); }

  log(entry) {
    const st = this.st;
    st.log.unshift({ em: agoraBr(), ...entry });
    st.log.length = Math.min(st.log.length, 100);
    this.store.save();
  }

  /** Recebe o payload do webhook de mensagem. Devolve o que foi feito, para a resposta HTTP. */
  handle(body) {
    const st = this.st;
    const m = parseMessageWebhook(body);
    // guarda só o que a equipe mandou: com "mensagem recebida" ligado, as dos clientes empurrariam as da equipe para fora
    if (m.fromMe) {
      st.amostras.unshift({ em: agoraBr(), payload: sample(body) });
      st.amostras.length = Math.min(st.amostras.length, 5);
    }
    if (!m.isAudio) { this.store.save(); return { ignorado: 'não é áudio' }; }
    if (!m.fromMe) { this.store.save(); return { ignorado: 'áudio do cliente (o Revvy já transcreve)' }; }
    if (!m.conversationId) { this.log({ resultado: 'ignorado', detalhe: 'áudio sem conversation_id no webhook' }); return { ignorado: 'sem conversa' }; }
    if (!m.mediaUrl && !m.base64) { this.log({ resultado: 'ignorado', conversa: m.conversationId, detalhe: 'webhook não trouxe o link nem o conteúdo do áudio' }); return { ignorado: 'sem link do áudio' }; }
    if (!this.ligado) { this.log({ resultado: 'ignorado', conversa: m.conversationId, detalhe: 'transcrição desligada (TRANSCREVER_AUDIOS_EQUIPE e OPENAI_API_KEY)' }); return { ignorado: 'desligado' }; }
    const key = m.messageId || `${m.conversationId}:${m.mediaUrl || m.base64.slice(0, 40)}`;
    if (st.feitos[key] || st.fila[key]) { this.store.save(); return { ignorado: 'já transcrito' }; }
    st.fila[key] = m;
    this.store.save();
    this.schedule({ key, m, attempts: 0 }, 0);
    return { ok: true, transcrevendo: true };
  }

  schedule(job, delayMs) {
    const t = setTimeout(() => { this.timers.delete(t); this.run(job); }, delayMs);
    this.timers.add(t);
  }

  async run(job) {
    const { key, m } = job;
    try {
      const audio = await this.download(m);
      const texto = (await this.transcribe(audio, m.mime)).trim();
      const quem = m.senderName ? ` de ${m.senderName}` : '';
      const hora = hourBr(m.at);
      const nota = `🎙️ Transcrição do áudio${quem}${hora ? ` (${hora})` : ''}:\n${texto || '(áudio sem fala)'}`.slice(0, 4000);
      await this.revvy.request(`/api/v1/conversations/${encodeURIComponent(m.conversationId)}/notes`, 0, {
        method: 'POST',
        body: { note: nota, ...(m.userId && this.cfg.autorDaNota ? { note_user_id: m.userId } : {}) },
        headers: { 'Idempotency-Key': `audio-${key}`.slice(0, 128) },
      });
      delete this.st.fila[key];
      this.st.feitos[key] = Math.floor(Date.now() / 1000);
      this.log({ resultado: 'transcrito', conversa: m.conversationId, caracteres: texto.length });
    } catch (err) {
      job.attempts += 1;
      const delay = RETRY_DELAYS_S[job.attempts - 1];
      if (delay === undefined || err.permanent) {
        delete this.st.fila[key];
        this.log({ resultado: 'erro', conversa: m.conversationId, detalhe: err.message });
        this.logger.error(`[áudio] desistiu da conversa ${m.conversationId}: ${err.message}`);
      } else {
        this.log({ resultado: 'nova tentativa', conversa: m.conversationId, tentativa: job.attempts, detalhe: err.message });
        this.logger.warn(`[áudio] tentando de novo em ${delay} s: ${err.message}`);
        this.schedule(job, delay * 1000);
      }
    }
  }

  async download(m) {
    if (m.base64) return Buffer.from(m.base64, 'base64');
    // link do próprio Revvy pode exigir a chave da API; links externos (WhatsApp/S3) vão sem ela
    const sameHost = new URL(m.mediaUrl).host === new URL(this.revvyCfg.baseUrl).host;
    const res = await this.fetch(m.mediaUrl, { headers: sameHost ? { Authorization: `Bearer ${this.revvyCfg.apiKey}` } : {} });
    if (!res.ok) {
      const err = new Error(`não consegui baixar o áudio (${res.status})`);
      err.permanent = res.status === 404 || res.status === 403;
      throw err;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 25 * 1024 * 1024) throw Object.assign(new Error('áudio maior que 25 MB'), { permanent: true });
    return buf;
  }

  async transcribe(audio, mime) {
    const ext = /mpeg|mp3/i.test(mime || '') ? 'mp3' : /mp4|m4a|aac/i.test(mime || '') ? 'm4a' : /wav/i.test(mime || '') ? 'wav' : 'ogg';
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mime || 'audio/ogg' }), `audio.${ext}`);
    form.append('model', this.cfg.modelo);
    form.append('language', 'pt');
    const res = await this.fetch(`${this.cfg.apiUrl}/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.cfg.apiKey}` }, body: form,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`transcrição respondeu ${res.status}: ${text.slice(0, 200)}`);
      err.permanent = res.status === 400 || res.status === 401;
      throw err;
    }
    try { return JSON.parse(text).text || ''; } catch { return text; }
  }

  stop() { for (const t of this.timers) clearTimeout(t); this.timers.clear(); }
}
