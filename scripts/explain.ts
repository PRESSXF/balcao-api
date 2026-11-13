/**
 * Gera docs/EXPLAIN.md: o plano real (EXPLAIN ANALYZE, BUFFERS) das consultas
 * mais frequentes, com e sem o índice que cada uma usa.
 *
 * Pré-requisito: banco migrado e com volume (`npm run db:carga`).
 * Uso: npm run explain
 *
 * Cada caso roda numa transação que é desfeita no fim: o índice é apagado só
 * dentro dela (DROP INDEX é transacional no PostgreSQL) e as consultas rodam
 * com SET LOCAL ROLE balcao_app e app.tenant_id definido, exatamente como a
 * API, então o plano inclui o filtro do RLS.
 */
import { writeFile } from 'node:fs/promises'
import { cpus, totalmem } from 'node:os'
import pg from 'pg'
import { carregarConfig } from '../src/config.js'

interface Caso {
  titulo: string
  porque: string
  indice: string
  papel: 'balcao_app' | 'balcao_worker'
  preparar?: string
  sql: (ids: Ids) => string
}
interface Ids {
  tenant: string
  profissional: string
  dia: string
  nomeMeio: string
  clienteMeio: string
}

const CASOS: Caso[] = [
  {
    titulo: 'Agenda do dia (GET /v1/agenda)',
    porque: 'A tela mais aberta do produto. Filtra a empresa pelo RLS e o dia pelo início do período, já ordenado.',
    indice: 'agendamentos_tenant_inicio',
    papel: 'balcao_app',
    sql: (i) => `
      select a.id, a.inicio, upper(a.periodo) as fim, a.status, c.nome as cliente
        from agendamentos a
        join clientes c on c.tenant_id = a.tenant_id and c.id = a.cliente_id
       where a.inicio >= ('${i.dia}'::date)::timestamp at time zone 'America/Recife'
         and a.inicio <  ('${i.dia}'::date + 1)::timestamp at time zone 'America/Recife'
       order by a.inicio, a.id`,
  },
  {
    titulo: 'Clientes por nome, página do meio (GET /v1/clientes?cursor=...)',
    porque: 'Paginação por cursor (nome, id): o índice entrega as linhas já na ordem e a consulta para no limite, sem ordenar a empresa inteira.',
    indice: 'clientes_tenant_nome',
    papel: 'balcao_app',
    sql: (i) => `
      select id, nome, telefone from clientes
       where (nome, id) > ('${i.nomeMeio.replace(/'/g, "''")}', '${i.clienteMeio}'::uuid)
       order by nome, id
       limit 21`,
  },
  {
    titulo: 'Worker pegando o próximo job (FOR UPDATE SKIP LOCKED)',
    porque:
      'Roda o tempo todo, em cada worker. Com 300 mil jobs concluídos e 20 pendentes, o índice parcial só contém os pendentes.',
    indice: 'jobs_prontos',
    papel: 'balcao_worker',
    preparar: `
      insert into jobs (tenant_id, tipo, payload, status, tentativas, executar_em, concluido_em)
      select t.id, 'entrega_webhook', '{}', 'concluido', 1, now() - make_interval(secs => g), now() - make_interval(secs => g)
        from generate_series(1, 300000) g
        cross join lateral (select id from tenants where slug like 'carga-%' order by id offset (g % 50) limit 1) t;
      insert into jobs (tenant_id, tipo, payload, executar_em)
      select (select id from tenants where slug like 'carga-%' order by id limit 1), 'lembrete_agendamento', '{}', now() - make_interval(secs => g)
        from generate_series(1, 20) g;
      analyze jobs;`,
    sql: () => `
      select id from jobs
       where status = 'pendente' and executar_em <= now()
       order by executar_em, id
       for update skip locked
       limit 4`,
  },
  {
    titulo: 'Checagem de sobreposição (restrição de exclusão)',
    porque:
      'É o que o PostgreSQL faz a cada INSERT em agendamentos. O índice GiST da restrição responde "existe período que cruza este?" para o profissional.',
    indice: 'agendamentos_sem_sobreposicao',
    papel: 'balcao_app',
    sql: (i) => `
      select id from agendamentos
       where tenant_id = app_tenant() and profissional_id = '${i.profissional}'
         and periodo && tstzrange(('${i.dia}'::date + time '10:30') at time zone 'America/Recife',
                                  ('${i.dia}'::date + time '11:20') at time zone 'America/Recife', '[)')
         and status in ('agendado', 'confirmado')`,
  },
]

function tempoExecucao(plano: string): number {
  const m = /Execution Time: ([\d.]+) ms/.exec(plano)
  return m ? Number(m[1]) : NaN
}

async function main() {
  const config = carregarConfig()
  const admin = new pg.Client({ connectionString: config.adminDatabaseUrl, application_name: 'balcao-explain' })
  await admin.connect()
  const q = async <T extends pg.QueryResultRow>(sql: string) => (await admin.query<T>(sql)).rows

  const [tenant] = await q<{ id: string }>(`select id from tenants where slug = 'carga-001'`)
  if (!tenant) throw new Error('Rode antes: npm run db:carga')
  const [prof] = await q<{ id: string }>(`select id from profissionais where tenant_id = '${tenant.id}' order by id limit 1`)
  const [meio] = await q<{ id: string; nome: string }>(`select id, nome from clientes where tenant_id = '${tenant.id}' order by nome, id offset 1000 limit 1`)
  const [{ dia }] = (await q<{ dia: string }>(`select (now() at time zone 'America/Recife')::date::text as dia`)) as [{ dia: string }]
  const ids: Ids = { tenant: tenant.id, profissional: prof!.id, dia, nomeMeio: meio!.nome, clienteMeio: meio!.id }
  const volume = (
    await q<{ t: string; n: number }>(`
      select 'empresas' as t, count(*)::int as n from tenants union all
      select 'clientes', count(*)::int from clientes union all
      select 'agendamentos', count(*)::int from agendamentos`)
  ).map((r) => `${r.n.toLocaleString('pt-BR')} ${r.t}`)
  const versao = (await q<{ v: string }>("select split_part(current_setting('server_version'), ' ', 1) as v"))[0]!.v

  const secoes: string[] = []
  const resumo: string[] = []
  for (const caso of CASOS) {
    const rodar = async (semIndice: boolean) => {
      await admin.query('begin')
      try {
        if (caso.preparar) await admin.query(caso.preparar)
        if (semIndice) {
          if (caso.indice === 'agendamentos_sem_sobreposicao') await admin.query(`alter table agendamentos drop constraint ${caso.indice}`)
          else await admin.query(`drop index ${caso.indice}`)
        }
        await admin.query(`set local role ${caso.papel}`)
        await admin.query(`select set_config('app.tenant_id', '${ids.tenant}', true)`)
        // Aquece o cache para comparar planos, não leitura de disco.
        await admin.query(caso.sql(ids))
        const r = await admin.query<{ 'QUERY PLAN': string }>(`explain (analyze, buffers) ${caso.sql(ids)}`)
        return r.rows.map((x) => x['QUERY PLAN']).join('\n')
      } finally {
        await admin.query('rollback')
      }
    }
    const com = await rodar(false)
    const sem = await rodar(true)
    const tc = tempoExecucao(com)
    const ts = tempoExecucao(sem)
    resumo.push(`| ${caso.titulo} | \`${caso.indice}\` | ${tc.toFixed(2)} ms | ${ts.toFixed(2)} ms | ${(ts / tc).toFixed(0)}x |`)
    secoes.push(
      `## ${caso.titulo}\n\n${caso.porque}\n\n\`\`\`sql${caso.sql(ids).replace(/^\n/, '\n').replace(/\n {6}/g, '\n')}\n\`\`\`\n\n` +
        `### Com \`${caso.indice}\` (${tc.toFixed(2)} ms)\n\n\`\`\`\n${com}\n\`\`\`\n\n` +
        `### Sem o índice (${ts.toFixed(2)} ms)\n\n\`\`\`\n${sem}\n\`\`\`\n`,
    )
    console.log(`${caso.titulo}: ${tc.toFixed(2)} ms com índice, ${ts.toFixed(2)} ms sem`)
  }
  await admin.end()

  const doc = `# Índices justificados com EXPLAIN ANALYZE

Gerado por \`npm run explain\` em ${new Date().toISOString().slice(0, 10)}. Cada consulta rodou duas vezes na mesma base, numa
transação desfeita no fim: com o índice e com o índice apagado (\`DROP INDEX\` dentro da transação). As consultas
rodam como \`balcao_app\` (ou \`balcao_worker\`) com \`app.tenant_id\` definido, como na API, então o filtro do RLS
aparece no plano.

**Base:** PostgreSQL ${versao}, ${volume.join(', ')} (\`npm run db:carga\`: 50 empresas sintéticas mais as 3 de
demonstração). Empresa consultada: \`carga-001\`. **Máquina:** ${cpus().length} vCPU (${cpus()[0]?.model.trim()}),
${Math.round(totalmem() / 2 ** 30)} GB de RAM, banco local, cache aquecido. Os tempos absolutos variam de máquina para
máquina; o que importa é a forma do plano e a ordem de grandeza.

| Consulta | Índice | Com | Sem | Diferença |
|---|---|---|---|---|
${resumo.join('\n')}

Observações:

- Os índices começam por \`tenant_id\` porque toda consulta passa pela política \`tenant_id = app_tenant()\`. Como
  \`app_tenant()\` é \`STABLE\`, o planejador usa o valor como chave de índice (aparece como \`Index Cond\`).
- **Achado que virou a migração 0008.** A primeira versão indexava \`(tenant_id, lower(periodo))\` e o plano da agenda
  ignorava o índice. Sob RLS, o PostgreSQL só usa como chave de índice uma condição da consulta cujas funções sejam
  \`LEAKPROOF\` (senão a função poderia vazar, num erro, dados de linhas que a política ainda não filtrou).
  \`lower(tstzrange)\` não é; comparação de \`timestamptz\` é. A coluna gerada \`inicio\` resolveu: agora o
  \`Index Cond\` tem empresa e intervalo do dia, e só as 50 linhas do dia são lidas.
- O mesmo vale para \`&&\` (sobreposição de intervalos), que não é leakproof: numa consulta sob RLS o índice GiST
  filtra só por empresa e profissional. A checagem da restrição de exclusão no INSERT é interna do PostgreSQL e usa o
  índice inteiro, sem essa limitação.
- Nas linhas "sem", o planejador recorre a outro índice que começa por \`tenant_id\` (o de cliente ou o de telefone)
  e descarta linha a linha o resto da empresa. Por isso a diferença é pequena com 2 mil clientes e 4 mil agendamentos
  por empresa, e cresce com o tamanho da empresa, não com o total do sistema. Sem nenhum índice por \`tenant_id\`,
  seria leitura sequencial da tabela de todas as empresas.
- O índice parcial \`jobs_prontos\` só guarda jobs pendentes. A tabela pode acumular milhões de jobs concluídos sem
  deixar o worker mais lento.
- A restrição de exclusão cria o próprio índice GiST. Sem ele não há como garantir a regra; a linha "sem" mostra só o
  custo de verificar sobreposição sem índice.

${secoes.join('\n')}`
  await writeFile('docs/EXPLAIN.md', doc)
  console.log('docs/EXPLAIN.md atualizado.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
