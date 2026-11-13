import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant, wrap } from '../../src/db/pool.js'
import { A, B, C, abrirAmbiente, idsDe, resetar, type Ambiente } from './helpers.js'

/**
 * Prova de isolamento entre empresas no próprio banco. Tudo aqui roda com o
 * papel balcao_app (o mesmo da API), com SQL escrito de propósito para tentar
 * escapar da empresa da transação.
 */

let amb: Ambiente
let totalA: number
let totalB: number

beforeAll(async () => {
  amb = abrirAmbiente()
  await resetar(amb.admin)
  const contar = async (t: string) =>
    (await amb.admin.query<{ n: number }>('select count(*)::int as n from clientes where tenant_id = $1', [t])).rows[0]!.n
  totalA = await contar(A)
  totalB = await contar(B)
})
afterAll(() => amb.fechar())

/** Executa SQL como balcao_app numa transação com a empresa definida e desfaz no fim. */
async function comoEmpresa<T>(tenant: string | null, fn: (q: (sql: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>) => Promise<T>): Promise<T> {
  const client = await amb.app.connect()
  try {
    await client.query('begin')
    if (tenant) await client.query(`select set_config('app.tenant_id', $1, true)`, [tenant])
    const r = await fn(async (sql, p) => {
      const res = await client.query(sql, p)
      return { rows: res.rows, rowCount: res.rowCount ?? 0 }
    })
    return r
  } finally {
    await client.query('rollback').catch(() => {})
    client.release()
  }
}

describe('papéis do banco', () => {
  it('a API conecta com um papel sem superusuário e sem BYPASSRLS', async () => {
    const { rows } = await amb.app.query('select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user')
    expect(rows[0]).toEqual({ current_user: 'balcao_app', rolsuper: false, rolbypassrls: false })
  })

  it('toda tabela com tenant_id tem RLS ligado e forçado, com política', async () => {
    const { rows } = await amb.admin.query<{ tabela: string; rls: boolean; forcado: boolean; politicas: number }>(
      `select c.relname as tabela, c.relrowsecurity as rls, c.relforcerowsecurity as forcado,
              (select count(*)::int from pg_policies p where p.tablename = c.relname) as politicas
         from pg_class c
         join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
        where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace`,
    )
    expect(rows.length).toBeGreaterThanOrEqual(11)
    for (const r of rows) {
      expect(r, r.tabela).toMatchObject({ rls: true, forcado: true })
      expect(r.politicas, r.tabela).toBeGreaterThan(0)
    }
  })

  it('a API não consegue desligar o RLS, virar outro papel nem desligar gatilhos', async () => {
    await expect(amb.app.query('alter table clientes disable row level security')).rejects.toMatchObject({ code: '42501' })
    await expect(amb.app.query('alter table clientes no force row level security')).rejects.toMatchObject({ code: '42501' })
    await expect(amb.app.query('set role balcao_worker')).rejects.toMatchObject({ code: '42501' })
    await expect(amb.app.query('set session_replication_role = replica')).rejects.toMatchObject({ code: '42501' })
    await expect(amb.app.query('drop policy isolamento_empresa on clientes')).rejects.toMatchObject({ code: '42501' })
  })
})

describe('sem empresa definida', () => {
  it('esquecer app.tenant_id não devolve nenhuma linha de nenhuma tabela', async () => {
    for (const t of ['usuarios', 'clientes', 'servicos', 'profissionais', 'agendamentos', 'pedidos', 'itens_pedido', 'auditoria', 'jobs', 'outbox', 'refresh_tokens']) {
      const { rows } = await amb.app.query(`select count(*)::int as n from ${t}`)
      expect(rows[0], t).toEqual({ n: 0 })
    }
  })

  it('e não deixa inserir', async () => {
    await expect(
      amb.app.query(`insert into clientes (tenant_id, nome, telefone) values ($1, 'Intrusa', '+5581990000001')`, [A]),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('SET LOCAL não vaza: a conexão volta ao pool sem empresa', async () => {
    const pool = amb.app
    const visto = await withTenant(pool, { tenantId: A }, (db) => db.one<{ n: number }>('select count(*)::int as n from clientes'))
    expect(visto.n).toBe(totalA)
    // Mesmo pool, consultas fora de transação: nada visível e configuração vazia.
    for (let i = 0; i < 15; i++) {
      const { rows } = await pool.query(`select count(*)::int as n, coalesce(current_setting('app.tenant_id', true), '') as t from clientes`)
      expect(rows[0]).toEqual({ n: 0, t: '' })
    }
  })

  it('e não vaza nem quando a transação falha', async () => {
    await expect(
      withTenant(amb.app, { tenantId: A }, async (db) => {
        await db.query('select 1')
        throw new Error('falha no meio')
      }),
    ).rejects.toThrow('falha no meio')
    const { rows } = await amb.app.query('select count(*)::int as n from clientes')
    expect(rows[0]).toEqual({ n: 0 })
  })
})

describe('empresa A tentando alcançar a empresa B', () => {
  it('lê só as próprias linhas, mesmo filtrando pelo tenant de B', async () => {
    await comoEmpresa(A, async (q) => {
      const todas = await q('select tenant_id from clientes')
      expect(todas.rows).toHaveLength(totalA)
      expect(new Set(todas.rows.map((r) => r.tenant_id))).toEqual(new Set([A]))
      expect((await q('select * from clientes where tenant_id = $1', [B])).rows).toHaveLength(0)
      expect((await q('select * from clientes where tenant_id = $1 or true', [B])).rows).toHaveLength(totalA)
      expect((await q('select * from agendamentos where tenant_id <> $1', [A])).rows).toHaveLength(0)
    })
  })

  it('não enxerga B por join, subconsulta, CTE ou função de agregação', async () => {
    await comoEmpresa(A, async (q) => {
      const r = await q(
        `with todos as (select * from clientes)
         select (select count(*) from todos where tenant_id = $1)::int as cte,
                (select count(*) from agendamentos a join clientes c on c.id = a.cliente_id where c.tenant_id = $1)::int as junta,
                (select count(*) from (select tenant_id from pedidos union all select tenant_id from itens_pedido) x where tenant_id = $1)::int as uniao,
                (select coalesce(jsonb_agg(u.email), '[]') from usuarios u where u.tenant_id = $1) as emails`,
        [B],
      )
      expect(r.rows[0]).toEqual({ cte: 0, junta: 0, uniao: 0, emails: [] })
    })
  })

  it('UPDATE e DELETE em linhas de B afetam zero linhas', async () => {
    const { profissionais } = await idsDe(amb.admin, B)
    await comoEmpresa(A, async (q) => {
      expect((await q(`update clientes set nome = 'Invadido' where tenant_id = $1`, [B])).rowCount).toBe(0)
      expect((await q(`update profissionais set nome = 'Invadido' where id = $1`, [profissionais[0]])).rowCount).toBe(0)
      expect((await q(`delete from agendamentos where tenant_id = $1`, [B])).rowCount).toBe(0)
      // DELETE sem filtro apaga só o que é da própria empresa (e a transação é desfeita).
      const apagados = (await q('delete from pedidos')).rowCount
      const deA = (await amb.admin.query('select count(*)::int as n from pedidos where tenant_id = $1', [A])).rows[0].n as number
      expect(apagados).toBe(deA)
    })
    const { rows } = await amb.admin.query(`select count(*)::int as n from clientes where tenant_id = $1 and nome = 'Invadido'`, [B])
    expect(rows[0]).toEqual({ n: 0 })
  })

  it('não insere linha com tenant de B nem move linha própria para B', async () => {
    await comoEmpresa(A, async (q) => {
      await expect(q(`insert into clientes (tenant_id, nome, telefone) values ($1, 'Plantada', '+5581990000002')`, [B])).rejects.toMatchObject({ code: '42501' })
    })
    await comoEmpresa(A, async (q) => {
      await expect(q(`update clientes set tenant_id = $1`, [B])).rejects.toMatchObject({ code: '42501' })
    })
  })

  it('não referencia profissional, cliente ou serviço de B (chave estrangeira composta)', async () => {
    const a = await idsDe(amb.admin, A)
    const b = await idsDe(amb.admin, B)
    await comoEmpresa(A, async (q) => {
      await expect(
        q(
          `insert into agendamentos (tenant_id, profissional_id, cliente_id, servico_id, periodo, preco_centavos)
           values ($1, $2, $3, $4, tstzrange('2026-12-01 10:00-03', '2026-12-01 10:30-03'), 100)`,
          [A, b.profissionais[0], a.clientes[0], a.servicos[0]],
        ),
      ).rejects.toMatchObject({ code: '23503' })
    })
  })

  it('não lê colunas de webhook de empresa nenhuma (permissão por coluna)', async () => {
    await comoEmpresa(A, async (q) => {
      await expect(q('select webhook_segredo from tenants')).rejects.toMatchObject({ code: '42501' })
    })
    await comoEmpresa(A, async (q) => {
      const dir = await q('select slug from tenants order by slug')
      expect(dir.rows.map((r) => r.slug)).toEqual(['clinica-boa-vista', 'sabor-do-capibaribe', 'salao-mare-alta'])
    })
  })

  it('não altera nem apaga a auditoria, nem a própria', async () => {
    await comoEmpresa(A, async (q) => {
      await expect(q(`update auditoria set acao = 'DELETE'`)).rejects.toMatchObject({ code: '42501' })
    })
    await comoEmpresa(A, async (q) => {
      await expect(q('delete from auditoria')).rejects.toMatchObject({ code: '42501' })
    })
  })

  it('trocar app.tenant_id no meio da transação só troca a visão, sem misturar', async () => {
    await comoEmpresa(A, async (q) => {
      expect((await q('select count(*)::int as n from clientes')).rows[0]!.n).toBe(totalA)
      await q(`select set_config('app.tenant_id', $1, true)`, [B])
      const r = await q('select count(*)::int as n, count(distinct tenant_id)::int as empresas from clientes')
      expect(r.rows[0]).toEqual({ n: totalB, empresas: 1 })
    })
  })
})

describe('worker', () => {
  it('enxerga a fila de todas as empresas, mas as outras tabelas só com empresa definida', async () => {
    const client = await amb.worker.connect()
    try {
      const fila = await client.query('select count(distinct tenant_id)::int as n from jobs')
      expect(fila.rows[0].n).toBeGreaterThanOrEqual(2)
      expect((await client.query('select count(*)::int as n from clientes')).rows[0].n).toBe(0)
      expect((await client.query('select count(*)::int as n from tenants')).rows[0].n).toBe(0)
      await client.query('begin')
      await client.query(`select set_config('app.tenant_id', $1, true)`, [C])
      const t = await client.query('select slug, webhook_url is not null as tem_webhook from tenants')
      expect(t.rows).toEqual([{ slug: 'sabor-do-capibaribe', tem_webhook: true }])
      await client.query('rollback')
    } finally {
      client.release()
    }
  })

  it('o resumo da fila (SECURITY DEFINER) devolve só contagens', async () => {
    const r = await wrap(amb.app).query('select * from fila_resumo() order by tipo, status')
    expect(r.length).toBeGreaterThan(0)
    expect(Object.keys(r[0]!).sort()).toEqual(['mais_antigo', 'status', 'tipo', 'total'])
  })
})
