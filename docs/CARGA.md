# Teste de carga

Gerado por `npm run carga` em 2026-11-13 23:15 UTC.

**Condições.** Uma máquina só, com 2 vCPU (Intel(R) Xeon(R) Processor @ 2.10GHz) e 8 GB de RAM,
dividida entre o gerador de carga (autocannon), a API (um processo Node 22, build de produção, `LOG_LEVEL=warn`, pool de
10 conexões) e o PostgreSQL 16 (configuração padrão, `shared_buffers=256MB`). Sem rede no meio. 20 conexões
simultâneas por 15 s em cada cenário. Base com 53 empresas, 100 mil clientes e 200 mil agendamentos; todas as
requisições autenticadas como o dono da empresa `carga-001`.

Os números servem para ordem de grandeza e comparação entre cenários, não como promessa de produção: o gerador de
carga disputa CPU com a API e com o banco, o que puxa a vazão para baixo e a latência para cima.

| Cenário | req/s | p50 | p95 | p99 | Erros | O que cada requisição faz |
|---|---|---|---|---|---|---|
| `GET /health` | 18.264 | 1,0 ms | 2,2 ms | 4,8 ms | 0 | sem banco: teto do Fastify nesta máquina |
| `GET /v1/agenda` | 489 | 39,5 ms | 57,5 ms | 68,1 ms | 0 | JWT, transação com app.tenant_id, RLS, junção de 4 tabelas, 50 agendamentos |
| `GET /v1/clientes` | 1.706 | 11,0 ms | 17,2 ms | 22,7 ms | 0 | página de 20 com cursor numa empresa de 2 mil clientes |
| `POST /v1/pedidos` | 592 | 33,0 ms | 47,1 ms | 54,2 ms | 0 | escrita: pedido + itens + gatilho de total + auditoria + job de webhook, numa transação, chave nova a cada requisição |

Latência medida pelo autocannon, do envio ao fim da resposta, para cada requisição; percentis calculados sobre todas.

Leitura dos números:

- Nos cenários com banco, o gargalo é CPU, não o PostgreSQL. A consulta da agenda leva menos de 1 ms no banco
  (docs/EXPLAIN.md); o resto é a ida e volta de 3 consultas mais BEGIN/COMMIT por requisição, o parse de 50 linhas e a
  serialização de uma resposta de cerca de 22 KB (a de clientes tem 3 KB), tudo disputando 2 vCPU com o gerador de carga
  e o banco.
- A escrita (`POST /v1/pedidos`) passa por gatilho de total, gatilho de auditoria e enfileiramento do webhook na
  mesma transação, e mesmo assim responde na casa das dezenas de milissegundos sob carga.
- Para escalar: mais processos da API atrás do Caddy (o estado fica todo no banco), réplicas de leitura para a agenda e
  um pooler como o PgBouncer em modo transação, que é compatível com o `SET LOCAL` usado para o RLS.
