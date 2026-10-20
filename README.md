# revvy-meta

Envia as etapas do funil do **Revvy** (kanban) para o **Gerenciador de Eventos da Meta** pela Conversions API.

Toda vez que um card muda de coluna no Revvy, o programa:
1. confere a assinatura do webhook (HMAC), para aceitar só avisos do Revvy;
2. busca o negócio e o contato na API do Revvy;
3. escolhe o formato do evento pela origem do lead:
   - **Direct do Instagram** (o Revvy guarda o contato como `instagram:<id>`) → Conversions API for Business Messaging, canal Instagram;
   - **WhatsApp** → Conversions API padrão, com o telefone (e nome, e-mail e cidade, se houver) em hash SHA-256. Se o contato tiver o campo `ctwa_clid` (anúncio de clique para WhatsApp), vai pela Business Messaging;
   - **formulário da Meta** (campo `meta_lead_id` no contato) → Conversions API for CRM;
4. envia à Meta. Se o card pulou etapas, as anteriores do funil também são enviadas, na ordem, como a Meta pede.

Proteções:
- **Sem duplicados:** cada etapa de cada negócio é enviada uma única vez.
- **Fila com novas tentativas:** se a Meta ou o Revvy falharem, o envio é repetido por cerca de 10 horas, mesmo que o servidor reinicie.
- **Reconciliação a cada hora:** relê o histórico de etapas dos negócios recentes e envia o que algum webhook não avisou (dentro dos 7 dias que a Meta aceita).

---

## Instalação no Easypanel

1. **Criar o serviço:** no seu projeto do Easypanel, clique em **+ Service → App** e dê o nome `revvy-meta`.
2. **Origem do código:** na aba **Source**, escolha **GitHub**, selecione o repositório `fernandesbreno/revvy-meta`, branch `main`. Em **Build**, deixe **Dockerfile**. Salve.
   - Se o Easypanel pedir, conecte sua conta do GitHub em *Settings → GitHub* do Easypanel.
3. **Variáveis:** na aba **Environment**, cole as linhas abaixo e preencha:
   ```
   REVVY_API_KEY=
   REVVY_WEBHOOK_SECRET=
   META_DATASET_ID=
   META_ACCESS_TOKEN=
   META_TEST_EVENT_CODE=
   ADMIN_TOKEN=
   INSTAGRAM_BUSINESS_ACCOUNT_ID=
   META_DATASET_ID_INSTAGRAM=
   ```
   | Variável | Onde pegar |
   |---|---|
   | `REVVY_API_KEY` | Revvy → Configurações → Integrações → API (API Key da empresa) |
   | `REVVY_WEBHOOK_SECRET` | Revvy → Configurações → Integrações → Webhooks (o *secret* do webhook, passo 6) |
   | `META_DATASET_ID` | Gerenciador de Eventos → seu conjunto de dados (o número do ID) |
   | `META_ACCESS_TOKEN` | Gerenciador de Eventos → integração manual de CRM / Configurações → **Gerar token de acesso** |
   | `META_TEST_EVENT_CODE` | Aba **Testar eventos** do Gerenciador. Use só durante os testes e depois apague |
   | `ADMIN_TOKEN` | Invente uma senha longa; serve para abrir a página `/status` |
   | `INSTAGRAM_BUSINESS_ACCOUNT_ID` | ID da conta profissional do Instagram (Configurações do negócio → Contas → Contas do Instagram). Sem ele, leads do Direct não são enviados |
   | `META_DATASET_ID_WHATSAPP` | Opcional. Conjunto de dados ligado à conta do WhatsApp, quando é outro que não o `META_DATASET_ID` (os eventos de clique para WhatsApp vão para ele; os demais continuam no `META_DATASET_ID`) |
   | `META_DATASET_ID_INSTAGRAM` | Opcional. Só se a Meta criar um conjunto de dados separado para o Instagram; se vazio, usa `META_DATASET_ID` |
   | `WHATSAPP_BUSINESS_ACCOUNT_ID` | ID da conta do WhatsApp Business (Gerenciador do WhatsApp). Com ele, leads de anúncio de clique para WhatsApp vão pelo `ctwa_clid` que o Revvy guarda na origem da conversa; se a Meta recusar, o programa envia pelo telefone |
   | `FACEBOOK_PAGE_ID` / `META_DATASET_ID_MESSENGER` | Opcional, só se usar o Messenger |
4. **Guardar o histórico:** na aba **Mounts**, adicione um **Volume** com *Mount Path* `/data`. É onde fica o registro do que já foi enviado.
5. **Endereço:** na aba **Domains**, confira se existe um domínio (o Easypanel cria um automaticamente) com a mesma porta que aparece no log "ouvindo na porta" (o Easypanel costuma usar **80**). Clique em **Deploy**.
   - Teste abrindo `https://SEU-DOMINIO/health`. Deve aparecer `"ok": true`.
6. **Webhook no Revvy:** em Revvy → Configurações → Integrações → Webhooks, crie um webhook com a URL
   `https://SEU-DOMINIO/webhooks/revvy`, marque o evento de **movimentação de card** (e de negócio ganho/perdido, se existirem) e copie o **secret** para `REVVY_WEBHOOK_SECRET`. Clique em **Deploy** de novo no Easypanel.

## Testar
1. Com `META_TEST_EVENT_CODE` preenchido, mova um card de teste no Revvy.
2. Veja o evento na aba **Testar eventos** da Meta.
3. Confira também `https://SEU-DOMINIO/status?token=SEU_ADMIN_TOKEN`: mostra os últimos envios, o que foi ignorado e por quê (sem dados pessoais).
4. Trocou o `META_DATASET_ID`? Abra `https://SEU-DOMINIO/reenviar?token=SEU_ADMIN_TOKEN&confirmar=sim` uma vez depois do Implantar: o app esquece o que já tinha enviado e manda de novo ao conjunto novo tudo dos últimos 7 dias (o limite da Meta).
5. Funcionou? Apague `META_TEST_EVENT_CODE` e clique em **Deploy**. A partir daí vai para produção.

## Leads dos formulários da Meta → Revvy
Com `LEADS_PAGE_ID` preenchido, o programa busca a cada 2 minutos os leads novos dos formulários de anúncio da página. Para cada um:
1. cria o contato no Revvy, ou acha o existente pelo telefone, e grava o ID do lead no campo `meta_lead_id`;
2. cria o card na coluna **Novo Lead** do setor **Comercial**, com as respostas do formulário nas notas.

A partir daí, cada etapa desse card vai para a Meta pela rota CRM. É essa rota que permite otimizar campanhas de cadastro para **leads qualificados**.

| Variável | Padrão | Para que serve |
|---|---|---|
| `LEADS_PAGE_ID` | vazio (desligado) | ID da página do Facebook dos formulários |
| `META_LEADS_TOKEN` | usa `META_ACCESS_TOKEN` | Token com as permissões `leads_retrieval`, `pages_show_list`, `pages_read_engagement` e `pages_manage_metadata`, e acesso à página. Um token de usuário do sistema no Gerenciador de Negócios serve |
| `LEADS_A_CADA_MINUTOS` | `2` | Intervalo da busca |
| `LEADS_DIAS_ATRAS` | `0` | Na primeira execução, quantos dias para trás importar. Com `0`, só os leads que chegarem a partir de agora |
| `LEADS_SETOR` / `LEADS_COLUNA` | `Comercial` / `Novo Lead` | Onde o card é criado |

Leads sem telefone são ignorados, porque o Revvy exige telefone para criar o card. Se o token não tiver permissão, o log mostra uma linha `[formulário]` com o motivo e o resto do programa continua funcionando.

## Distribuição dos leads entre as atendentes
Com `DISTRIBUIR_ATENDENTES` preenchido, o programa olha a coluna **Novo Lead** a cada 20 segundos. Cada negócio que entrar ali depois de ligar a distribuição vai para a próxima atendente da lista, em rodízio exato (Ana, Eli, Ruana, Ana...). O programa define a responsável do card e transfere a conversa aberta do contato para ela. A vez fica guardada no volume `/data`, então a divisão continua igual depois de reiniciar.

Se o contato já foi distribuído nos últimos 30 dias, ele volta para a mesma atendente e não gasta a vez de ninguém. Por isso, testes com o mesmo número sempre caem na mesma pessoa.

A saudação com o nome de cada atendente sai do Revvy, de um workflow por atendente com o gatilho **Negócio atribuído a um vendedor**. Desligue a distribuição automática do próprio Revvy para as duas não brigarem.

| Variável | Padrão | Para que serve |
|---|---|---|
| `DISTRIBUIR_ATENDENTES` | vazio (desligado) | `Nome:id` de cada atendente, separados por vírgula, na ordem do rodízio |
| `DISTRIBUIR_A_CADA_SEGUNDOS` | `20` | Intervalo da verificação |
| `DISTRIBUIR_COLUNA` | `Novo Lead` | Coluna de onde saem os negócios a distribuir |
| `DISTRIBUIR_ETIQUETAS` | `true` | Põe no contato a etiqueta com o nome da atendente (pela API, para sincronizar com o WhatsApp Business) |
| `DISTRIBUIR_COLUNAS_SEM_DONA` | `Em Atendimento` | Colunas seguintes onde o programa também procura negócios novos **sem atendente** (o lead respondeu antes da distribuição e a automação já moveu o card). Separe várias por vírgula; vazio desliga |
| `DISTRIBUIR_SO_WHATSAPP` | `true` | Só distribui contatos com telefone (WhatsApp e formulário). Instagram e Facebook ficam sem dona e sem saudação. `false` distribui todos |
| `DISTRIBUIR_IGNORAR_ETIQUETAS` | `Pago` | Contatos com estas etiquetas (separadas por vírgula) não são distribuídos nem saudados: é o cliente que já comprou e voltou a falar. Vazio desliga |
| `DISTRIBUIR_ETIQUETA_ABORDADO` | `Abordado` | Quando a atendente já abordou o lead pelo celular (a conversa existe mais de 1 minuto antes do card), o app põe esta etiqueta e depois atribui. O workflow de saudação pula quem tem esta etiqueta. Vazio desliga |
| `DISTRIBUIR_HORARIO` | vazio (24 horas) | Horário de atendimento, no fuso de Fortaleza. Ex.: `seg-sex 08:00-18:00; sab 08:00-12:00`. Fora dele os leads esperam e, na abertura, são distribuídos do mais antigo para o mais novo. Lead que uma atendente pegou antes (é a responsável do card ou da conversa) fica com ela a qualquer hora: o programa põe a etiqueta e transfere a conversa, sem gastar a vez e sem regravar o card |

O `/status` mostra quantos leads cada uma recebeu e quem é a próxima.

## Transcrição dos áudios da equipe
O Revvy transcreve os áudios do cliente, mas não os que a atendente manda. Com isto ligado, cada áudio enviado pela equipe é transcrito e vira uma **nota interna da conversa** (aparece no inbox só para a equipe e no histórico do contato), no nome de quem mandou o áudio.

1. No Easypanel, acrescente em **Environment** e clique em **Deploy**:
   ```
   TRANSCREVER_AUDIOS_EQUIPE=true
   OPENAI_API_KEY=
   ```
   A chave sai de platform.openai.com → API keys (precisa de crédito na conta; o modelo padrão custa por volta de US$ 0,003 por minuto de áudio).
2. Em Revvy → Configurações → Integrações → Webhooks, crie um webhook com a URL `https://SEU-DOMINIO/webhooks/revvy`, marque só **Nova mensagem enviada** e salve.
3. Copie o *secret* desse webhook para `REVVY_WEBHOOK_SECRET_MENSAGENS` (se for o mesmo do outro webhook, não precisa) e clique em **Deploy**.
4. Mande um áudio de teste e abra `https://SEU-DOMINIO/audios?token=SEU_ADMIN_TOKEN`: mostra os áudios transcritos, os erros e os últimos webhooks de mensagem que chegaram.

| Variável | Padrão | Para que serve |
|---|---|---|
| `TRANSCREVER_AUDIOS_EQUIPE` | `false` | Liga a transcrição |
| `OPENAI_API_KEY` | — | Chave do serviço de transcrição |
| `REVVY_WEBHOOK_SECRET_MENSAGENS` | — | Secret do webhook de mensagens, quando é diferente do `REVVY_WEBHOOK_SECRET` |
| `TRANSCRICAO_MODELO` | `gpt-4o-mini-transcribe` | Modelo de transcrição (`whisper-1` também serve) |
| `TRANSCRICAO_API_URL` | `https://api.openai.com/v1` | Outro serviço compatível com a API da OpenAI |
| `TRANSCRICAO_AUTOR_DA_NOTA` | `true` | `false` grava a nota no nome do administrador em vez de quem mandou o áudio |

### Áudios mandados pelo celular
O Revvy só avisa as mensagens enviadas pela tela dele. As que a atendente manda pelo app do WhatsApp no celular (número em coexistência com a API oficial) chegam ao app direto da Meta, pelo webhook `smb_message_echoes`. O app baixa o áudio pela Graph API, acha a conversa do contato no Revvy pelo telefone e grava a nota.

1. Em developers.facebook.com, no app da Meta da empresa: **WhatsApp → Configuração → Webhook**. URL de callback `https://SEU-DOMINIO/webhooks/whatsapp`, token de verificação igual ao `WHATSAPP_VERIFY_TOKEN`. Depois, em **Campos do webhook**, assine `smb_message_echoes`. O app precisa estar no modo **Publicado** (Live).
2. Ligue o app à conta do WhatsApp: no Explorador da Graph API, com esse app e um token com `whatsapp_business_management`, faça `POST /{WHATSAPP_BUSINESS_ACCOUNT_ID}/subscribed_apps`. O Revvy continua recebendo tudo normalmente.
3. Variáveis:

| Variável | Para que serve |
|---|---|
| `WHATSAPP_VERIFY_TOKEN` | Senha que você inventa e repete no painel da Meta |
| `META_APP_SECRET` | Configurações do app → Básico → Chave secreta do app. Sem ela os avisos são recusados |
| `WHATSAPP_TOKEN` | Token de usuário do sistema com `whatsapp_business_messaging` e acesso à conta do WhatsApp, para baixar os áudios. Se vazio, usa o `META_ACCESS_TOKEN` |

## Etapas do funil
O arquivo [`etapas.json`](etapas.json) liga o nome de cada coluna do kanban ao evento da Meta. Para mudar, edite o arquivo aqui no GitHub e clique em **Deploy** no Easypanel. Maiúsculas e acentos não importam.

## Campos personalizados no Revvy
Opcionais. Leads do Instagram e do WhatsApp já funcionam sem nenhum campo extra. Para formulários da Meta e anúncios de clique para WhatsApp, crie no contato os campos `meta_lead_id`, `ctwa_clid`, `fbc` e `fbp`.

## Token de acesso
Para o Instagram, o token precisa da permissão `instagram_manage_events`. Não está confirmado que o token gerado em Gerenciador de Eventos → API de Conversões tenha essa permissão. Se a Meta recusar os eventos do Instagram, o motivo aparece em `/status`.

## Variáveis opcionais
| Variável | Padrão | Para que serve |
|---|---|---|
| `META_GRAPH_VERSION` | `v24.0` | Versão da API da Meta |
| `LEAD_EVENT_SOURCE` | `Revvy` | Nome do CRM que aparece na Meta |
| `RECONCILIAR_A_CADA_MINUTOS` | `60` | Intervalo da reconciliação (0 desliga) |
| `RECONCILIAR_DIAS` | `30` | Negócios criados há até quantos dias entram na reconciliação |
| `PREENCHER_ETAPAS_PULADAS` | `true` | Envia etapas anteriores quando o card pula etapas |
| `VALIDAR_ASSINATURA` | `true` | Só desligue para depurar |

## Desenvolvimento
```
npm test
```
Sem dependências externas: Node.js 20+ puro.

## Política de privacidade

O app publica uma política de privacidade em `/privacidade` (também `/privacy`), exigida pela Meta para colocar o app em modo Live. O texto usa `EMPRESA_NOME` (padrão "Ice Laser") e, se definido, `PRIVACIDADE_CONTATO` (e-mail ou WhatsApp para pedidos de dados).

## Confirmação de sessão → Recepção

Com `CONFIRMACAO_RECEPCAO=true`, quando a equipe manda a mensagem de confirmação da sessão ("Passando para confirmar sua sessão do dia ..."), o card do cliente vai para a etapa `RECEPCAO_COLUNA` (padrão "Recepção") e o contato ganha a etiqueta `RECEPCAO_ETIQUETA` (padrão "Cliente - Recepção"; vazio para não etiquetar). Se o cliente não tiver card, um é criado na Recepção.

- A mensagem é reconhecida pela frase, não pela data: `CONFIRMACAO_FRASES` (separadas por `|`, sem acento; padrão `confirmar sua sessao|confirmar a sua sessao`).
- Mandada pela tela do Revvy: chega pelo webhook de mensagens (o mesmo da transcrição de áudios).
- Mandada pelo celular: chega pelo webhook da Meta em `/webhooks/whatsapp` (campo `smb_message_echoes`, o mesmo dos áudios).
- O que foi feito fica em `/recepcao?token=ADMIN_TOKEN`.
