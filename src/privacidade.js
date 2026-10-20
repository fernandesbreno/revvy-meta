/** Página pública de política de privacidade, exigida pela Meta para publicar o app. */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function privacyPage({ empresa, contato }) {
  const e = esc(empresa);
  const c = contato ? esc(contato) : '';
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Política de Privacidade · ${e}</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 760px; margin: 0 auto; padding: 32px 16px; line-height: 1.6; color: #1f2933; background: #fff; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.15rem; margin-top: 1.8em; }
</style>
</head>
<body>
<h1>Política de Privacidade</h1>
<p><strong>${e}</strong> · atualizada em 20 de outubro de 2026</p>

<p>Esta política explica como o aplicativo de integração da ${e} trata os dados recebidos da Meta (WhatsApp, Facebook e Instagram) e do nosso sistema de atendimento (CRM). O aplicativo é de uso interno: não é oferecido ao público e não coleta dados diretamente de quem navega na internet.</p>

<h2>1. Quais dados tratamos</h2>
<ul>
  <li>Dados de contato de clientes e interessados que falam com a ${e}: nome, telefone, e-mail e cidade.</li>
  <li>Mensagens e áudios trocados no WhatsApp entre nossa equipe e os clientes.</li>
  <li>Dados de formulários de anúncios (Lead Ads) preenchidos pelos interessados.</li>
  <li>Identificadores de anúncios e cliques, como o identificador do lead e do clique no anúncio.</li>
</ul>

<h2>2. Para que usamos</h2>
<ul>
  <li>Registrar o atendimento no nosso CRM, incluindo a transcrição dos áudios da equipe como nota interna da conversa.</li>
  <li>Distribuir os atendimentos entre as consultoras.</li>
  <li>Informar à Meta, de forma agregada e com dados pessoais protegidos por hash, as etapas do funil (por exemplo, lead qualificado e venda) para medir e otimizar os anúncios.</li>
</ul>

<h2>3. Com quem compartilhamos</h2>
<p>Os dados são compartilhados apenas com os serviços necessários para essas finalidades: a Meta (WhatsApp Business Platform e API de Conversões), o nosso CRM de atendimento e o serviço de transcrição de áudio (OpenAI), que recebe somente o áudio a ser transcrito. Não vendemos dados pessoais.</p>

<h2>4. Armazenamento e segurança</h2>
<p>Os dados ficam no CRM e em um servidor próprio, com acesso restrito à equipe responsável. O aplicativo guarda apenas registros técnicos mínimos (como identificadores de mensagens já processadas), sem o conteúdo das conversas.</p>

<h2>5. Seus direitos</h2>
<p>Conforme a Lei Geral de Proteção de Dados (LGPD), você pode pedir acesso, correção ou exclusão dos seus dados, além de informações sobre o uso deles${c ? `, pelo contato <strong>${c}</strong>` : ', falando com a nossa equipe pelo WhatsApp'}.</p>

<h2>6. Exclusão de dados</h2>
<p>Para excluir seus dados, envie o pedido${c ? ` para <strong>${c}</strong>` : ' pelo WhatsApp da ' + e}. A exclusão é feita no CRM e nos registros do aplicativo em até 30 dias.</p>

<h2>7. Alterações</h2>
<p>Esta política pode ser atualizada. A versão vigente fica sempre nesta página.</p>
</body>
</html>`;
}
