/**
 * FRASES_ETAPAS: regras separadas por ";" ou quebra de linha; em cada uma, frases separadas por "|" e "=>" antes da etapa.
 * Ex.: "segue o link da avaliação|link para agendar => Link/Avaliação Marcada; pagamento confirmado => Venda Concluída"
 */
export function parseFrasesEtapas(raw) {
  const regras = [];
  for (const parte of String(raw || '').split(/[;\n]/)) {
    const i = parte.lastIndexOf('=>');
    if (i < 0) continue;
    const frases = parte.slice(0, i).split('|').map((f) => f.trim()).filter(Boolean);
    const coluna = parte.slice(i + 2).trim();
    if (frases.length && coluna) regras.push({ frases, coluna, etiqueta: '', protegeEtapas: true });
  }
  return regras;
}
