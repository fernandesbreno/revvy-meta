# revvy-meta

Envia as etapas do funil do **Revvy** (kanban) para o **Gerenciador de Eventos da Meta** pela Conversions API.

Toda vez que um card muda de coluna no Revvy, o programa:
1. confere a assinatura do webhook (HMAC), para aceitar só avisos do Revvy;
2. busca o negócio e o contato na API do Revvy;
3. escolhe o formato do evento pela origem do lead:
   - **formulário da Meta** (campo `meta_lead_id` no contato) → Conversions API for CRM;
   - **anúncio de WhatsApp** (campo `ctwa_clid`) → Conversions API for Business Messaging;
   - **demais origens** → Conversions API padrão, com e-mail, telefone, nome e cidade em hash SHA-256;
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
   WHATSAPP_BUSINESS_ACCOUNT_ID=
   ```
   | Variável | Onde pegar |
   |---|---|
   | `REVVY_API_KEY` | Revvy → Configurações → Integrações → API (API Key da empresa) |
   | `REVVY_WEBHOOK_SECRET` | Revvy → Configurações → Integrações → Webhooks (o *secret* do webhook, passo 6) |
   | `META_DATASET_ID` | Gerenciador de Eventos → seu conjunto de dados (o número do ID) |
   | `META_ACCESS_TOKEN` | Gerenciador de Eventos → integração manual de CRM / Configurações → **Gerar token de acesso** |
   | `META_TEST_EVENT_CODE` | Aba **Testar eventos** do Gerenciador. Use só durante os testes e depois apague |
   | `ADMIN_TOKEN` | Invente uma senha longa; serve para abrir a página `/status` |
   | `WHATSAPP_BUSINESS_ACCOUNT_ID` | Opcional, só para anúncios de clique para WhatsApp |
4. **Guardar o histórico:** na aba **Mounts**, adicione um **Volume** com *Mount Path* `/data`. É onde fica o registro do que já foi enviado.
5. **Endereço:** na aba **Domains**, confira se existe um domínio (o Easypanel cria um automaticamente) com a porta **3000**. Clique em **Deploy**.
   - Teste abrindo `https://SEU-DOMINIO/health`. Deve aparecer `"ok": true`.
6. **Webhook no Revvy:** em Revvy → Configurações → Integrações → Webhooks, crie um webhook com a URL
   `https://SEU-DOMINIO/webhooks/revvy`, marque o evento de **movimentação de card** (e de negócio ganho/perdido, se existirem) e copie o **secret** para `REVVY_WEBHOOK_SECRET`. Clique em **Deploy** de novo no Easypanel.

## Testar
1. Com `META_TEST_EVENT_CODE` preenchido, mova um card de teste no Revvy.
2. Veja o evento na aba **Testar eventos** da Meta.
3. Confira também `https://SEU-DOMINIO/status?token=SEU_ADMIN_TOKEN`: mostra os últimos envios, o que foi ignorado e por quê (sem dados pessoais).
4. Funcionou? Apague `META_TEST_EVENT_CODE` e clique em **Deploy**. A partir daí vai para produção.

## Etapas do funil
O arquivo [`etapas.json`](etapas.json) liga o nome de cada coluna do kanban ao evento da Meta. Para mudar, edite o arquivo aqui no GitHub e clique em **Deploy** no Easypanel. Maiúsculas e acentos não importam.

## Campos personalizados no Revvy
Crie no contato os campos `meta_lead_id`, `ctwa_clid`, `fbc` e `fbp`. São eles que dizem de onde o lead veio. Sem nenhum deles, o lead vai pela rota padrão (e-mail e telefone).

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
