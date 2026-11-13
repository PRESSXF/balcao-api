# Arquitetura e decisões

Este documento explica como o Balcão está organizado e por que cada escolha foi feita.

## Camadas

```
HTTP (Fastify)          http/app.ts, http/routes/*, http/erros.ts
        │  req.db(fn): transação com app.tenant_id
acesso a dados          db/pool.ts (withTenant, Db tipado), SQL escrito à mão nas rotas
        │
PostgreSQL 16           RLS, restrição de exclusão, checagens, gatilhos, fila
        ▲
worker                  jobs/worker.ts, jobs/fila.ts, jobs/handlers.ts
```

A API e o worker não conversam entre si: os dois só falam com o banco. A API grava o job na mesma transação da mudança que o originou; o worker é acordado por `NOTIFY` e executa.

## Decisões

### 1. PostgreSQL dedicado e auto-hospedado

**Problema.** Supabase e Firebase resolvem o início, mas prendem o projeto a um fornecedor, a um modelo de cobrança e, no caso do Firebase, a um banco sem transações entre coleções nem restrições declarativas. Para clientes pequenos, custo previsível e poder rodar num servidor qualquer contam muito.

**Decisão.** PostgreSQL 16 oficial em Docker, com volume nomeado, rodando ao lado da API. Nenhuma extensão fora das que vêm com o PostgreSQL (`btree_gist` e `citext`).

**Consequência.** O mesmo `docker compose up` sobe o ambiente no notebook e numa VM de qualquer nuvem ([`DEPLOY.md`](DEPLOY.md)). Em troca, backup, atualização e monitoramento são responsabilidade nossa: por isso existem `scripts/backup.sh`, `scripts/restore-verify.sh`, `/ready` e `/metrics`. Migrar depois para um PostgreSQL gerenciado (RDS, Cloud SQL, Neon) é trocar a URL de conexão.

### 2. Isolamento entre empresas com Row Level Security

**Problema.** Em sistema multiempresa, o vazamento clássico é a consulta que esqueceu o `where tenant_id = ...`. Revisão de código diminui, mas não elimina.

**Decisão.**

- Toda tabela de empresa tem `tenant_id`, RLS ligado e **forçado** (`FORCE ROW LEVEL SECURITY`, para valer também para o dono da tabela) e a política `tenant_id = app_tenant()` em `USING` e `WITH CHECK`.
- `app_tenant()` lê `current_setting('app.tenant_id', true)`. Sem valor, devolve `NULL`, e `tenant_id = NULL` nunca é verdadeiro: nenhuma linha passa e nenhuma inserção é aceita.
- A API conecta como `balcao_app` (sem superusuário, sem `BYPASSRLS`, sem ser dona das tabelas) e cada requisição autenticada roda em `withTenant()`: `BEGIN`, `set_config('app.tenant_id', $1, true)`, SQL, `COMMIT`. O terceiro argumento `true` torna o valor local à transação (como `SET LOCAL`, mas aceitando parâmetro), então a conexão volta ao pool sem empresa.
- Chaves estrangeiras compostas `(tenant_id, x_id)` impedem que um agendamento da empresa A aponte para um profissional da empresa B, mesmo que alguém descubra o id. A checagem de chave estrangeira ignora RLS; a chave composta não.
- O diretório de empresas (`tenants`) é legível sem empresa definida, porque o login começa pelo slug. As colunas de webhook ficam fora do `GRANT` por coluna da API.
- O worker conecta como `balcao_worker`, que tem uma política extra só na tabela `jobs` para enxergar a fila de todas as empresas. Para executar um job, ele define `app.tenant_id` com a empresa do job e passa a obedecer às mesmas políticas da API.

**Consequência.** Um bug de filtro na aplicação devolve zero linhas, não os dados de outra empresa. A suíte `tests/integration/rls.test.ts` tenta escapar com SQL escrito de propósito e confere no catálogo que nenhuma tabela com `tenant_id` ficou sem RLS forçado; tabela nova esquecida quebra o teste.

### 3. Regras de agenda e dinheiro no banco

**Problema.** "Não marcar dois clientes no mesmo horário" feito na aplicação é um `SELECT` seguido de `INSERT`. Duas requisições simultâneas passam pelo `SELECT` juntas e as duas inserem.

**Decisão.** Restrição de exclusão:

```sql
constraint agendamentos_sem_sobreposicao exclude using gist (
  tenant_id with =, profissional_id with =, periodo with &&
) where (status in ('agendado', 'confirmado'))
```

- `periodo` é `tstzrange` semiaberto `[início, fim)`: 10:00–10:30 e 10:30–11:00 não colidem.
- `btree_gist` permite misturar igualdade (`=`) e sobreposição (`&&`) no mesmo índice GiST.
- O `WHERE` parcial faz agendamento cancelado ou concluído liberar o horário.
- Checagens completam: período não vazio, finito e de no máximo 8 horas; preço e duração em faixas válidas; telefone no padrão E.164 do Brasil; webhook com URL e segredo juntos.
- Um gatilho `BEFORE UPDATE` recusa transições inválidas (cancelado não volta a agendado) com mensagem em português e `HINT` usado como código de erro pela API.
- Dinheiro é sempre inteiro em centavos. O total do pedido é recalculado por um gatilho por comando (`FOR EACH STATEMENT` com tabela de transição): inserir 5 itens gera um único `UPDATE` no pedido.

**Consequência.** A regra vale para a API, para o worker, para um script de correção e para um `psql` aberto em produção. O teste que dispara 10 inserções simultâneas no mesmo horário termina com exatamente uma aceita.

### 4. Auditoria por gatilho

**Decisão.** Um gatilho `AFTER INSERT OR UPDATE OR DELETE` em usuários, clientes, serviços, profissionais, agendamentos e pedidos grava em `auditoria`: tabela, id, ação, usuário (`app.user_id`), id da requisição (`app.request_id`), linha antes e depois em `jsonb`. `UPDATE` que não muda nada não gera registro e `senha_hash` nunca entra.

**Consequência.** Nenhuma alteração escapa, venha de onde vier, e cada registro liga com a linha de log da requisição. A API só tem `SELECT` e `INSERT` em `auditoria`; o teste confirma que `UPDATE` e `DELETE` são negados.

### 5. Fila de jobs no PostgreSQL, não no Redis

**Problema.** O lembrete precisa sair se, e somente se, o agendamento existir. Com Redis, gravar no banco e publicar na fila são duas operações: se o processo cair entre elas, ou o job some, ou existe job para um agendamento que sofreu rollback.

**Decisão.** Tabela `jobs` no mesmo banco.

- **Enfileirar** é um `INSERT` na mesma transação do agendamento ou pedido. Rollback de um desfaz o outro.
- **Pegar** é `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n)`: cada worker pula linhas que outro já travou, sem esperar e sem duplicar.
- **Acordar**: um gatilho faz `pg_notify('balcao_jobs')`; o worker escuta numa conexão dedicada. Sem notificação, dorme até o próximo `executar_em` ou um intervalo de segurança.
- **Falhar**: `tentativas` sobe ao pegar; na falha, volta para `pendente` com espera exponencial (base × 2^(n−1), ±20%, com teto) ou vai para `morto` ao esgotar as tentativas.
- **Worker que morreu** deixa o job em `executando`; depois do tempo limite da trava, outro worker devolve à fila. Concluir ou falhar exige `travado_por = eu`, então um worker atrasado não sobrescreve o resultado de outro.
- **Idempotência**: chave única `(tenant_id, chave_idempotencia)` no enfileiramento, e efeito idempotente nos handlers (a `outbox` tem chave única por mensagem). Rodar o mesmo lembrete duas vezes envia uma mensagem só.

**Consequência.** Uma peça a menos para operar e garantias transacionais de graça. O limite é vazão: a fila no PostgreSQL atende milhares de jobs por minuto, o que sobra para negócios pequenos, mas não substitui um Kafka. O índice parcial `jobs_prontos` mantém o custo de pegar job constante mesmo com milhões de concluídos (0,03 ms contra 67 ms sem ele, em [`EXPLAIN.md`](EXPLAIN.md)).

### 6. Autenticação própria

**Decisão.**

- **Senha**: `scrypt` do `node:crypto` (N = 2^15, r = 8, p = 1, sal de 16 bytes), parâmetros guardados no hash para poder subir o custo depois. Login com usuário inexistente compara contra um hash fictício para gastar o mesmo tempo.
- **Acesso**: JWT HS256 de 15 minutos implementado com HMAC. O cabeçalho é comparado byte a byte com o esperado (não há como pedir `alg: none`), assinatura comparada em tempo constante, claims validadas.
- **Renovação**: token opaco `<tenant>.<id>.<segredo>`, guardado só como SHA-256. Cada uso marca o token como usado e emite o próximo da mesma família. Se um token já usado reaparece, alguém o copiou: a família inteira é revogada.
- **Papéis** `dono` e `atendente` conferidos por rota (`app.exigir('dono')`).
- **Limite de login**: 5 tentativas por minuto por IP, com resposta `429` em português.

**Consequência.** Sem dependência de biblioteca de JWT e com cada propriedade de segurança testada. O token de acesso não é revogável antes de expirar; por isso é curto.

### 7. Migrações SQL sem ORM

**Problema.** ORMs pesados escondem justamente o que este projeto quer usar: restrição de exclusão, RLS, gatilhos com tabela de transição, `SECURITY DEFINER`, permissão por coluna.

**Decisão.** Arquivos `db/migrations/NNNN_nome.sql` e um executor de cerca de 150 linhas (`src/db/migrator.ts`): ordem numérica, uma transação por arquivo, SHA-256 do conteúdo em `schema_migrations`, `pg_advisory_lock` contra dois processos migrando ao mesmo tempo, comando `status`. Migração aplicada cujo arquivo mudou ou sumiu bloqueia tudo. A linha `-- balcao:sem-transacao` permite `CREATE INDEX CONCURRENTLY`. Nas rotas, SQL escrito à mão com uma camada mínima tipada (`db.one<T>()`, `db.query<T>()`).

**Consequência.** O esquema é lido como SQL, revisado como SQL e testado como SQL. A migração `0008` existe por causa do achado da decisão 11, e mostra o fluxo normal: não se edita a `0007`, cria-se a próxima.

### 8. Idempotência em `POST /v1/pedidos`

**Decisão.** Cabeçalho `Idempotency-Key` obrigatório. O pedido é inserido com `ON CONFLICT (tenant_id, chave_idempotencia) DO NOTHING`; se já existia, a API devolve o mesmo pedido com `Idempotent-Replayed: true`. Duas requisições simultâneas com a mesma chave se resolvem no índice único: a segunda espera a primeira terminar e cai no `DO NOTHING`. A mesma chave com corpo diferente (comparado por hash canônico) é `422`.

**Consequência.** Cliente com rede ruim pode repetir à vontade. O teste com 8 requisições simultâneas cria 1 pedido e 1 webhook.

### 9. Paginação por cursor

**Decisão.** Listas usam chave de ordenação estável (`(nome, id)`, `(inicio, id)`, `(criado_em, id)` ou `id`) e o cliente devolve o cursor opaco (base64url da chave). A consulta pede `limite + 1` linhas para saber se há próxima página.

**Consequência.** O custo de uma página não cresce com o número da página, e nada se repete nem some quando entram registros no meio da navegação. Cursor adulterado é `400 cursor_invalido`.

### 10. Um formato de erro, em português

**Decisão.** Toda resposta de erro é `{ erro: { codigo, mensagem, detalhes? }, requisicao }`. Erros de validação do Ajv são traduzidos campo a campo; erros do PostgreSQL são mapeados por restrição e por código (`23P01`, `23505`, `23503`, `23514`, `P0001`, `42501`). O id da requisição é o mesmo dos logs e da auditoria.

**Consequência.** O front-end trata `codigo` e mostra `mensagem` sem tradução. Um usuário que reporta um erro manda o id e o suporte acha a linha no log.

### 11. Índices que funcionam sob RLS

**Problema.** O primeiro índice da agenda, `(tenant_id, lower(periodo))`, não era usado. O `EXPLAIN ANALYZE` mostrava um índice só por empresa e 3.950 linhas descartadas por filtro.

**Decisão.** Sob RLS, o PostgreSQL só aplica uma condição da consulta antes do filtro da política (e portanto só a usa como chave de índice) se as funções dela forem `LEAKPROOF`, para que uma função não vaze num erro dados de linhas que a política ainda não filtrou. `lower(tstzrange)` não é; comparação de `timestamptz` é. A migração `0008` criou a coluna gerada `inicio` e o índice `(tenant_id, inicio, id)`.

**Consequência.** O plano passou a ler só as 50 linhas do dia. Fica a regra para o projeto: em tabela com RLS, condição que precisa de índice usa coluna comparada com operador padrão, não expressão sobre ela. Planos com e sem cada índice em [`EXPLAIN.md`](EXPLAIN.md).

### 12. Webhooks assinados e enviados com `node:http`

**Decisão.** Corpo JSON assinado como no Stripe: `X-Balcao-Assinatura: t=<unix>,v1=<HMAC-SHA256 de "t.corpo">`, com o segredo da empresa. O timestamp entra na assinatura para o receptor recusar reenvios antigos. Cada entrega leva `X-Balcao-Entrega` (igual em todas as tentativas) para o receptor deduplicar. O envio usa `node:http`/`https` e não `fetch`: o `fetch` do Node segue a lista de "portas ruins" da especificação Fetch e recusa, por exemplo, a porta 4190, e o receptor de um cliente pode estar em qualquer porta.

**Consequência.** Resposta fora de 2xx ou falha de rede vira nova tentativa com backoff; o teste de ponta a ponta sobe um servidor local, devolve 500 na primeira vez e confere a assinatura na segunda.

### 13. Operação observável

**Decisão.** Logs JSON com pino (cabeçalho de autorização e senhas ocultados). `/health` diz se o processo está vivo; `/ready` confere o banco e se a migração aplicada é a que o código espera, para o balanceador não mandar tráfego a uma versão adiantada. `/metrics` expõe duração das requisições por rota, falhas de login, conexões do pool, jobs por tipo e status e o atraso do job pendente mais antigo. A contagem da fila vem de `fila_resumo()`, uma função `SECURITY DEFINER` que pertence a `balcao_worker` e devolve só números: a API mede a fila sem poder ler linhas de outras empresas.

**Consequência.** Dá para alertar sobre "fila atrasada" e "migração não aplicada" sem acesso ao banco.

## Limites conhecidos

- **RLS por variável de sessão protege contra erro de aplicação, não contra injeção de SQL arbitrário.** O papel da API pode executar `set_config('app.tenant_id', ...)`; quem conseguisse rodar SQL livre como `balcao_app` trocaria de empresa. Todo SQL da API é parametrizado, e a API não consegue desligar RLS, trocar de papel nem alterar a auditoria (testado).
- **Migrações exigem superusuário** (criar papéis, extensões e trocar o dono de `fila_resumo()`). Em PostgreSQL gerenciado, use o usuário administrador do serviço.
- **Limite de login em memória**, por processo. Com várias réplicas da API, cada uma conta separado; o próximo passo é guardar o contador no banco ou no proxy.
- **Token de acesso vale até expirar** (15 minutos) mesmo depois de sair; a revogação imediata vale para a renovação.
- **Segredos de webhook em texto no banco**, legíveis só pelo worker. Cifrar com uma chave fora do banco é o próximo passo.
- **A fila cresce**: não há limpeza automática de jobs concluídos nem de auditoria antiga.
- **O console consulta a API a cada 1 a 2 segundos** em vez de usar SSE. É uma tela de demonstração, não o produto final.
- **Sem cadastro de empresas e usuários pela API**: entram pelo seed ou por SQL.
- **WhatsApp simulado**: o lembrete grava a mensagem na `outbox` após uma latência configurável.
- **Um processo de API faz cerca de 500 a 1.700 req/s** nas rotas com banco numa máquina de 2 vCPU dividida com o banco e o gerador de carga ([`CARGA.md`](CARGA.md)). Para mais, réplicas da API e um PgBouncer em modo transação, compatível com o `set_config(..., true)` usado para o RLS (o `LISTEN` do worker precisa de conexão direta).
