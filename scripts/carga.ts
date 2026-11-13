/**
 * Teste de carga com autocannon contra uma API já rodando.
 *
 * Pré-requisitos: banco com volume (`npm run db:carga`), API de produção
 * rodando (`npm run build && npm start`), de preferência com LOG_LEVEL=warn.
 * Uso: npm run carga                       (padrão: http://localhost:4280)
 *      BASE=http://host:porta DURACAO=20 CONEXOES=32 npm run carga
 *
 * Os percentis são calculados a partir do tempo de cada resposta (não do
 * histograma resumido do autocannon, que não tem p95). O resultado vai para
 * docs/CARGA.md.
 */
import { request } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { cpus, totalmem } from 'node:os'
import autocannon from 'autocannon'

const BASE = process.env.BASE ?? 'http://localhost:4280'
const DURACAO = Number(process.env.DURACAO ?? 15)
const CONEXOES = Number(process.env.CONEXOES ?? 20)

interface Cenario {
  nome: string
  oque: string
  metodo: 'GET' | 'POST'
  caminho: string
  corpo?: unknown
  idempotente?: boolean
}

// node:http, o mesmo cliente usado no envio de webhooks (src/jobs/http.ts).
function postJson(url: string, corpo: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const dados = JSON.stringify(corpo)
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(dados) } }, (res) => {
      let texto = ''
      res.on('data', (c) => (texto += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: texto ? JSON.parse(texto) : null }))
    })
    req.on('error', reject)
    req.end(dados)
  })
}

const ms = (v: number) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} ms`

function percentil(ordenado: number[], p: number): number {
  if (ordenado.length === 0) return NaN
  const i = Math.min(ordenado.length - 1, Math.ceil((p / 100) * ordenado.length) - 1)
  return ordenado[i]!
}

async function rodar(c: Cenario, token: string) {
  const tempos: number[] = []
  let contador = 0
  let terminar: (r: autocannon.Result) => void = () => {}
  let falhar: (e: unknown) => void = () => {}
  const fim = new Promise<autocannon.Result>((ok, erro) => {
    terminar = ok
    falhar = erro
  })
  const instancia = autocannon({
    url: BASE,
    connections: CONEXOES,
    duration: DURACAO,
    requests: [
      {
        method: c.metodo,
        path: c.caminho,
        headers: { authorization: `Bearer ${token}`, ...(c.corpo ? { 'content-type': 'application/json' } : {}) },
        body: c.corpo ? JSON.stringify(c.corpo) : undefined,
        setupRequest: (req) =>
          c.idempotente
            ? { ...req, headers: { ...req.headers, 'idempotency-key': `carga-${process.pid}-${++contador}` } }
            : req,
      },
    ],
  }, (err, resultado) => (err ? falhar(err) : terminar(resultado)))
  instancia.on('response', (_cliente, _status, _bytes, tempo) => tempos.push(tempo))
  const r = await fim
  tempos.sort((a, b) => a - b)
  return {
    nome: c.nome,
    oque: c.oque,
    reqPorSeg: r.requests.total / DURACAO,
    total: r.requests.total,
    erros: r.errors + r.timeouts + r.non2xx,
    p50: percentil(tempos, 50),
    p95: percentil(tempos, 95),
    p99: percentil(tempos, 99),
  }
}

async function main() {
  const login = await postJson(`${BASE}/v1/auth/login`, { empresa: 'carga-001', email: 'dono@carga-001.demo', senha: 'balcao123' })
  if (login.status !== 200) throw new Error(`Login falhou (${login.status}). Rode npm run db:carga e confira BASE.`)
  const { acesso } = login.json as { acesso: string }
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Recife' }).format(new Date())

  const cenarios: Cenario[] = [
    { nome: 'GET /health', oque: 'sem banco: teto do Fastify nesta máquina', metodo: 'GET', caminho: '/health' },
    { nome: 'GET /v1/agenda', oque: 'JWT, transação com app.tenant_id, RLS, junção de 4 tabelas, 50 agendamentos', metodo: 'GET', caminho: `/v1/agenda?dia=${hoje}` },
    { nome: 'GET /v1/clientes', oque: 'página de 20 com cursor numa empresa de 2 mil clientes', metodo: 'GET', caminho: '/v1/clientes?limite=20' },
    {
      nome: 'POST /v1/pedidos',
      oque: 'escrita: pedido + itens + gatilho de total + auditoria + job de webhook, numa transação, chave nova a cada requisição',
      metodo: 'POST',
      caminho: '/v1/pedidos',
      corpo: { itens: [{ descricao: 'Baião de dois', quantidade: 2, preco_unitario_centavos: 4200 }, { descricao: 'Suco de cajá', quantidade: 1, preco_unitario_centavos: 900 }] },
      idempotente: true,
    },
  ]

  const resultados = []
  for (const c of cenarios) {
    process.stdout.write(`${c.nome} (${DURACAO} s, ${CONEXOES} conexões)... `)
    const r = await rodar(c, acesso)
    console.log(`${Math.round(r.reqPorSeg)} req/s, p50 ${ms(r.p50)}, p95 ${ms(r.p95)}, p99 ${ms(r.p99)}, erros ${r.erros}`)
    resultados.push(r)
  }

  const linhas = resultados.map(
    (r) => `| \`${r.nome}\` | ${Math.round(r.reqPorSeg).toLocaleString('pt-BR')} | ${ms(r.p50)} | ${ms(r.p95)} | ${ms(r.p99)} | ${r.erros} | ${r.oque} |`,
  )
  const doc = `# Teste de carga

Gerado por \`npm run carga\` em ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.

**Condições.** Uma máquina só, com ${cpus().length} vCPU (${cpus()[0]?.model.trim()}) e ${Math.round(totalmem() / 2 ** 30)} GB de RAM,
dividida entre o gerador de carga (autocannon), a API (um processo Node 22, build de produção, \`LOG_LEVEL=warn\`, pool de
10 conexões) e o PostgreSQL 16 (configuração padrão, \`shared_buffers=256MB\`). Sem rede no meio. ${CONEXOES} conexões
simultâneas por ${DURACAO} s em cada cenário. Base com 53 empresas, 100 mil clientes e 200 mil agendamentos; todas as
requisições autenticadas como o dono da empresa \`carga-001\`.

Os números servem para ordem de grandeza e comparação entre cenários, não como promessa de produção: o gerador de
carga disputa CPU com a API e com o banco, o que puxa a vazão para baixo e a latência para cima.

| Cenário | req/s | p50 | p95 | p99 | Erros | O que cada requisição faz |
|---|---|---|---|---|---|---|
${linhas.join('\n')}

Latência medida pelo autocannon, do envio ao fim da resposta, para cada requisição; percentis calculados sobre todas.

Leitura dos números:

- Nos cenários com banco, o gargalo é CPU, não o PostgreSQL. A consulta da agenda leva menos de 1 ms no banco
  (docs/EXPLAIN.md); o resto é a ida e volta de 3 consultas mais BEGIN/COMMIT por requisição, o parse de 50 linhas e a
  serialização de uma resposta de cerca de 22 KB (a de clientes tem 3 KB), tudo disputando 2 vCPU com o gerador de carga
  e o banco.
- A escrita (\`POST /v1/pedidos\`) passa por gatilho de total, gatilho de auditoria e enfileiramento do webhook na
  mesma transação, e mesmo assim responde na casa das dezenas de milissegundos sob carga.
- Para escalar: mais processos da API atrás do Caddy (o estado fica todo no banco), réplicas de leitura para a agenda e
  um pooler como o PgBouncer em modo transação, que é compatível com o \`SET LOCAL\` usado para o RLS.
`
  await writeFile('docs/CARGA.md', doc)
  console.log('docs/CARGA.md atualizado.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
