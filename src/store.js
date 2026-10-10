import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Estado simples em JSON no volume /data:
 *  - sent: event_id -> epoch do envio (evita duplicados)
 *  - pending: trabalhos ainda não concluídos (sobrevivem a reinícios)
 *  - log: últimos 200 resultados, sem dados pessoais
 *  - leads: ids dos leads de formulário já importados e até quando já foi lido
 */
export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'estado.json');
    try {
      this.state = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      this.state = {};
    }
    this.state.sent ||= {};
    this.state.pending ||= [];
    this.state.log ||= [];
    this.state.leads ||= { importados: {}, desde: 0 }; // leads de formulário já trazidos para o Revvy
    this.testSent = new Set(); // envios em modo teste: só na memória, para não repetir a cada reconciliação
    this.prune();
  }

  save() {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.file);
  }

  prune(now = Date.now()) {
    const limit = Math.floor(now / 1000) - 180 * 24 * 3600;
    for (const [k, t] of Object.entries(this.state.sent)) if (t < limit) delete this.state.sent[k];
  }

  wasSent(id) { return Boolean(this.state.sent[id]) || this.testSent.has(id); }

  markSent(id, { test = false } = {}) {
    if (test) this.testSent.add(id);
    else this.state.sent[id] = Math.floor(Date.now() / 1000);
  }

  addPending(job) { this.state.pending.push(job); this.save(); }

  removePending(jobId) {
    this.state.pending = this.state.pending.filter((j) => j.id !== jobId);
    this.save();
  }

  updatePending(job) {
    const i = this.state.pending.findIndex((j) => j.id === job.id);
    if (i >= 0) this.state.pending[i] = job;
    this.save();
  }

  log(entry) {
    this.state.log.unshift({ em: new Date().toISOString(), ...entry });
    this.state.log.length = Math.min(this.state.log.length, 200);
    this.save();
  }
}
