# Índices justificados com EXPLAIN ANALYZE

Gerado por `npm run explain` em 2026-11-13. Cada consulta rodou duas vezes na mesma base, numa
transação desfeita no fim: com o índice e com o índice apagado (`DROP INDEX` dentro da transação). As consultas
rodam como `balcao_app` (ou `balcao_worker`) com `app.tenant_id` definido, como na API, então o filtro do RLS
aparece no plano.

**Base:** PostgreSQL 16.15, 53 empresas, 100.054 clientes, 200.161 agendamentos (`npm run db:carga`: 50 empresas sintéticas mais as 3 de
demonstração). Empresa consultada: `carga-001`. **Máquina:** 2 vCPU (Intel(R) Xeon(R) Processor @ 2.10GHz),
8 GB de RAM, banco local, cache aquecido. Os tempos absolutos variam de máquina para
máquina; o que importa é a forma do plano e a ordem de grandeza.

| Consulta | Índice | Com | Sem | Diferença |
|---|---|---|---|---|
| Agenda do dia (GET /v1/agenda) | `agendamentos_tenant_inicio` | 0.58 ms | 1.05 ms | 2x |
| Clientes por nome, página do meio (GET /v1/clientes?cursor=...) | `clientes_tenant_nome` | 0.03 ms | 0.56 ms | 21x |
| Worker pegando o próximo job (FOR UPDATE SKIP LOCKED) | `jobs_prontos` | 0.03 ms | 67.32 ms | 2493x |
| Checagem de sobreposição (restrição de exclusão) | `agendamentos_sem_sobreposicao` | 0.13 ms | 0.78 ms | 6x |

Observações:

- Os índices começam por `tenant_id` porque toda consulta passa pela política `tenant_id = app_tenant()`. Como
  `app_tenant()` é `STABLE`, o planejador usa o valor como chave de índice (aparece como `Index Cond`).
- **Achado que virou a migração 0008.** A primeira versão indexava `(tenant_id, lower(periodo))` e o plano da agenda
  ignorava o índice. Sob RLS, o PostgreSQL só usa como chave de índice uma condição da consulta cujas funções sejam
  `LEAKPROOF` (senão a função poderia vazar, num erro, dados de linhas que a política ainda não filtrou).
  `lower(tstzrange)` não é; comparação de `timestamptz` é. A coluna gerada `inicio` resolveu: agora o
  `Index Cond` tem empresa e intervalo do dia, e só as 50 linhas do dia são lidas.
- O mesmo vale para `&&` (sobreposição de intervalos), que não é leakproof: numa consulta sob RLS o índice GiST
  filtra só por empresa e profissional. A checagem da restrição de exclusão no INSERT é interna do PostgreSQL e usa o
  índice inteiro, sem essa limitação.
- Nas linhas "sem", o planejador recorre a outro índice que começa por `tenant_id` (o de cliente ou o de telefone)
  e descarta linha a linha o resto da empresa. Por isso a diferença é pequena com 2 mil clientes e 4 mil agendamentos
  por empresa, e cresce com o tamanho da empresa, não com o total do sistema. Sem nenhum índice por `tenant_id`,
  seria leitura sequencial da tabela de todas as empresas.
- O índice parcial `jobs_prontos` só guarda jobs pendentes. A tabela pode acumular milhões de jobs concluídos sem
  deixar o worker mais lento.
- A restrição de exclusão cria o próprio índice GiST. Sem ele não há como garantir a regra; a linha "sem" mostra só o
  custo de verificar sobreposição sem índice.

## Agenda do dia (GET /v1/agenda)

A tela mais aberta do produto. Filtra a empresa pelo RLS e o dia pelo início do período, já ordenado.

```sql
select a.id, a.inicio, upper(a.periodo) as fim, a.status, c.nome as cliente
  from agendamentos a
  join clientes c on c.tenant_id = a.tenant_id and c.id = a.cliente_id
 where a.inicio >= ('2026-11-13'::date)::timestamp at time zone 'America/Recife'
   and a.inicio <  ('2026-11-13'::date + 1)::timestamp at time zone 'America/Recife'
 order by a.inicio, a.id
```

### Com `agendamentos_tenant_inicio` (0.58 ms)

```
Sort  (cost=234.79..234.84 rows=19 width=58) (actual time=0.548..0.552 rows=50 loops=1)
  Sort Key: a.inicio, a.id
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=35
  ->  Hash Join  (cost=78.07..234.39 rows=19 width=58) (actual time=0.090..0.528 rows=50 loops=1)
        Hash Cond: (c.id = a.cliente_id)
        Buffers: shared hit=35
        ->  Index Only Scan using clientes_tenant_nome on clientes c  (cost=0.43..139.27 rows=1991 width=49) (actual time=0.018..0.305 rows=2000 loops=1)
              Index Cond: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
              Heap Fetches: 0
              Buffers: shared hit=29
        ->  Hash  (cost=77.40..77.40 rows=19 width=87) (actual time=0.045..0.046 rows=50 loops=1)
              Buckets: 1024  Batches: 1  Memory Usage: 14kB
              Buffers: shared hit=6
              ->  Bitmap Heap Scan on agendamentos a  (cost=4.67..77.40 rows=19 width=87) (actual time=0.023..0.032 rows=50 loops=1)
                    Recheck Cond: ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) AND (inicio >= '2026-11-13 00:00:00-03'::timestamp with time zone) AND (inicio < '2026-11-14 00:00:00-03'::timestamp with time zone))
                    Heap Blocks: exact=2
                    Buffers: shared hit=6
                    ->  Bitmap Index Scan on agendamentos_tenant_inicio  (cost=0.00..4.67 rows=19 width=0) (actual time=0.018..0.018 rows=50 loops=1)
                          Index Cond: ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) AND (inicio >= '2026-11-13 00:00:00-03'::timestamp with time zone) AND (inicio < '2026-11-14 00:00:00-03'::timestamp with time zone))
                          Buffers: shared hit=4
Planning:
  Buffers: shared hit=8
Planning Time: 0.328 ms
Execution Time: 0.580 ms
```

### Sem o índice (1.05 ms)

```
Sort  (cost=4650.26..4650.31 rows=19 width=58) (actual time=1.019..1.022 rows=50 loops=1)
  Sort Key: a.inicio, a.id
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=374
  ->  Nested Loop  (cost=64.72..4649.86 rows=19 width=58) (actual time=0.579..0.989 rows=50 loops=1)
        Buffers: shared hit=374
        ->  Bitmap Heap Scan on agendamentos a  (cost=64.30..4489.30 rows=19 width=87) (actual time=0.568..0.719 rows=50 loops=1)
              Recheck Cond: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
              Filter: ((inicio >= '2026-11-13 00:00:00-03'::timestamp with time zone) AND (inicio < '2026-11-14 00:00:00-03'::timestamp with time zone))
              Rows Removed by Filter: 3950
              Heap Blocks: exact=163
              Buffers: shared hit=174
              ->  Bitmap Index Scan on agendamentos_tenant_cliente  (cost=0.00..64.30 rows=3716 width=0) (actual time=0.162..0.163 rows=4000 loops=1)
                    Index Cond: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
                    Buffers: shared hit=11
        ->  Index Scan using clientes_pkey on clientes c  (cost=0.42..8.45 rows=1 width=49) (actual time=0.005..0.005 rows=1 loops=50)
              Index Cond: (id = a.cliente_id)
              Filter: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
              Buffers: shared hit=200
Planning:
  Buffers: shared hit=8
Planning Time: 0.224 ms
Execution Time: 1.046 ms
```

## Clientes por nome, página do meio (GET /v1/clientes?cursor=...)

Paginação por cursor (nome, id): o índice entrega as linhas já na ordem e a consulta para no limite, sem ordenar a empresa inteira.

```sql
select id, nome, telefone from clientes
 where (nome, id) > ('Fábio Araújo 105', '4b920fdb-9137-421c-ac7f-031ef33d0210'::uuid)
 order by nome, id
 limit 21
```

### Com `clientes_tenant_nome` (0.03 ms)

```
Limit  (cost=0.43..28.58 rows=21 width=48) (actual time=0.008..0.016 rows=21 loops=1)
  Buffers: shared hit=24
  ->  Index Scan using clientes_tenant_nome on clientes  (cost=0.43..1334.37 rows=995 width=48) (actual time=0.008..0.014 rows=21 loops=1)
        Index Cond: ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) AND (ROW(nome, id) > ROW('Fábio Araújo 105'::text, '4b920fdb-9137-421c-ac7f-031ef33d0210'::uuid)))
        Buffers: shared hit=24
Planning Time: 0.073 ms
Execution Time: 0.026 ms
```

### Sem o índice (0.56 ms)

```
Limit  (cost=1480.26..1480.31 rows=21 width=48) (actual time=0.539..0.543 rows=21 loops=1)
  Buffers: shared hit=40
  ->  Sort  (cost=1480.26..1482.74 rows=995 width=48) (actual time=0.539..0.540 rows=21 loops=1)
        Sort Key: nome, id
        Sort Method: top-N heapsort  Memory: 29kB
        Buffers: shared hit=40
        ->  Bitmap Heap Scan on clientes  (cost=67.61..1453.43 rows=995 width=48) (actual time=0.060..0.303 rows=999 loops=1)
              Recheck Cond: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
              Filter: (ROW(nome, id) > ROW('Fábio Araújo 105'::text, '4b920fdb-9137-421c-ac7f-031ef33d0210'::uuid))
              Rows Removed by Filter: 1001
              Heap Blocks: exact=26
              Buffers: shared hit=40
              ->  Bitmap Index Scan on clientes_tenant_id_telefone_key  (cost=0.00..67.36 rows=1991 width=0) (actual time=0.051..0.051 rows=2000 loops=1)
                    Index Cond: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
                    Buffers: shared hit=14
Planning Time: 0.067 ms
Execution Time: 0.555 ms
```

## Worker pegando o próximo job (FOR UPDATE SKIP LOCKED)

Roda o tempo todo, em cada worker. Com 300 mil jobs concluídos e 20 pendentes, o índice parcial só contém os pendentes.

```sql
select id from jobs
 where status = 'pendente' and executar_em <= now()
 order by executar_em, id
 for update skip locked
 limit 4
```

### Com `jobs_prontos` (0.03 ms)

```
Limit  (cost=0.14..8.79 rows=4 width=22) (actual time=0.011..0.014 rows=4 loops=1)
  Buffers: shared hit=6
  ->  LockRows  (cost=0.14..64.99 rows=30 width=22) (actual time=0.011..0.013 rows=4 loops=1)
        Buffers: shared hit=6
        ->  Index Scan using jobs_prontos on jobs  (cost=0.14..64.69 rows=30 width=22) (actual time=0.010..0.011 rows=4 loops=1)
              Index Cond: (executar_em <= now())
              Filter: (status = 'pendente'::text)
              Buffers: shared hit=2
Planning Time: 0.061 ms
Execution Time: 0.027 ms
```

### Sem o índice (67.32 ms)

```
Limit  (cost=32945.68..32945.73 rows=4 width=22) (actual time=67.292..67.296 rows=4 loops=1)
  Buffers: shared hit=18565 read=9134
  ->  LockRows  (cost=32945.68..32945.87 rows=15 width=22) (actual time=67.290..67.293 rows=4 loops=1)
        Buffers: shared hit=18565 read=9134
        ->  Sort  (cost=32945.68..32945.72 rows=15 width=22) (actual time=67.284..67.286 rows=4 loops=1)
              Sort Key: executar_em, id
              Sort Method: quicksort  Memory: 25kB
              Buffers: shared hit=18561 read=9134
              ->  Seq Scan on jobs  (cost=0.00..32945.46 rows=15 width=22) (actual time=67.267..67.272 rows=20 loops=1)
                    Filter: ((status = 'pendente'::text) AND (executar_em <= now()))
                    Rows Removed by Filter: 300006
                    Buffers: shared hit=18561 read=9134
Planning Time: 0.159 ms
Execution Time: 67.323 ms
```

## Checagem de sobreposição (restrição de exclusão)

É o que o PostgreSQL faz a cada INSERT em agendamentos. O índice GiST da restrição responde "existe período que cruza este?" para o profissional.

```sql
select id from agendamentos
 where tenant_id = app_tenant() and profissional_id = '3349cd52-f5e7-4005-a87e-e24782177987'
   and periodo && tstzrange(('2026-11-13'::date + time '10:30') at time zone 'America/Recife',
                            ('2026-11-13'::date + time '11:20') at time zone 'America/Recife', '[)')
   and status in ('agendado', 'confirmado')
```

### Com `agendamentos_sem_sobreposicao` (0.13 ms)

```
Bitmap Heap Scan on agendamentos  (cost=4.33..20.08 rows=1 width=16) (actual time=0.046..0.113 rows=2 loops=1)
  Recheck Cond: ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) AND (profissional_id = '3349cd52-f5e7-4005-a87e-e24782177987'::uuid) AND (status = ANY ('{agendado,confirmado}'::text[])))
  Filter: (periodo && '["2026-11-13 10:30:00-03","2026-11-13 11:20:00-03")'::tstzrange)
  Rows Removed by Filter: 198
  Heap Blocks: exact=24
  Buffers: shared hit=32
  ->  Bitmap Index Scan on agendamentos_sem_sobreposicao  (cost=0.00..4.33 rows=4 width=0) (actual time=0.036..0.036 rows=200 loops=1)
        Index Cond: ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) AND (profissional_id = '3349cd52-f5e7-4005-a87e-e24782177987'::uuid))
        Buffers: shared hit=8
Planning Time: 0.157 ms
Execution Time: 0.132 ms
```

### Sem o índice (0.78 ms)

```
Bitmap Heap Scan on agendamentos  (cost=64.30..4498.58 rows=1 width=16) (actual time=0.582..0.762 rows=2 loops=1)
  Recheck Cond: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
  Filter: ((status = ANY ('{agendado,confirmado}'::text[])) AND (profissional_id = '3349cd52-f5e7-4005-a87e-e24782177987'::uuid) AND (periodo && '["2026-11-13 10:30:00-03","2026-11-13 11:20:00-03")'::tstzrange))
  Rows Removed by Filter: 3998
  Heap Blocks: exact=163
  Buffers: shared hit=174
  ->  Bitmap Index Scan on agendamentos_tenant_cliente  (cost=0.00..64.30 rows=3716 width=0) (actual time=0.117..0.117 rows=4000 loops=1)
        Index Cond: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
        Buffers: shared hit=11
Planning Time: 0.098 ms
Execution Time: 0.775 ms
```
