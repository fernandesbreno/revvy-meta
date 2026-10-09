import { findStage } from './meta.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Rede de segurança: percorre os negócios recentes, lê o histórico de etapas e enfileira
 * qualquer movimentação dos últimos 7 dias que ainda não foi enviada (webhook perdido, servidor fora etc.).
 */
export async function reconcile({ cfg, store, revvy, processor, logger = console, pauseMs = 250 }) {
  const nowS = Math.floor(Date.now() / 1000);
  const createdLimit = nowS - cfg.reconcile.days * 24 * 3600;
  const movedLimit = nowS - 7 * 24 * 3600 + 3600;
  let offset = 0;
  let checked = 0;
  let queued = 0;

  for (let page = 0; page < 200; page++) {
    const r = await revvy.listDeals({ limit: 100, offset });
    const deals = r.data || [];
    for (const d of deals) {
      const created = Math.floor(new Date(d.created_at).getTime() / 1000);
      if (Number.isFinite(created) && created < createdLimit) continue;
      checked++;
      await sleep(pauseMs);
      let history;
      try {
        history = await revvy.stageHistory(d.id);
      } catch (err) {
        logger.warn(`histórico do negócio ${d.id} indisponível: ${err.message}`);
        continue;
      }
      for (const h of history) {
        const moved = Math.floor(new Date(h.moved_at).getTime() / 1000);
        if (!Number.isFinite(moved) || moved < movedLimit) continue;
        const stage = h.to_column && findStage(cfg, h.to_column.name);
        if (!stage) continue;
        const prefix = `${d.id}:${stage.key.replace(/\s+/g, '_')}`;
        if (store.wasSent(prefix)) continue;
        if (store.state.pending.some((j) => j.dealId === String(d.id) && (j.columnName || '').toLowerCase() === String(h.to_column.name).toLowerCase())) continue;
        processor.enqueue({ dealId: String(d.id), columnName: h.to_column.name, eventTime: moved, origem: 'reconciliação' });
        queued++;
      }
    }
    if (!(r.pagination && r.pagination.has_more) || !deals.length) break;
    offset += deals.length;
  }
  logger.log(`[reconciliação] ${checked} negócios verificados, ${queued} movimentações enfileiradas`);
  return { checked, queued };
}
