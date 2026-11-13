import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant, type Db } from '../../src/db/pool.js'
import { A, abrirAmbiente, idsDe, resetar, type Ambiente } from './helpers.js'

let amb: Ambiente
let ids: Awaited<ReturnType<typeof idsDe>>

beforeAll(async () => {
  amb = abrirAmbiente()
  await resetar(amb.admin)
  ids = await idsDe(amb.admin, A)
})
afterAll(() => amb.fechar())

const comoA = <T>(fn: (db: Db) => Promise<T>) => withTenant(amb.app, { tenantId: A }, fn)

async function agendar(db: Db, inicio: string, fim: string, prof = ids.profissionais[0]!) {
  return db.one<{ id: string }>(
    `insert into agendamentos (tenant_id, profissional_id, cliente_id, servico_id, periodo, preco_centavos)
     values (app_tenant(), $1, $2, $3, tstzrange($4, $5, '[)'), 1000) returning id`,
    [prof, ids.clientes[0], ids.servicos[0], inicio, fim],
  )
}

describe('restrição de exclusão: agenda sem sobreposição', () => {
  it('recusa período que se sobrepõe ao de outro agendamento do mesmo profissional', async () => {
    await comoA((db) => agendar(db, '2026-12-01T10:00:00-03:00', '2026-12-01T11:00:00-03:00'))
    await expect(comoA((db) => agendar(db, '2026-12-01T10:30:00-03:00', '2026-12-01T11:30:00-03:00'))).rejects.toMatchObject({
      code: '23P01',
      constraint: 'agendamentos_sem_sobreposicao',
    })
    await expect(comoA((db) => agendar(db, '2026-12-01T09:00:00-03:00', '2026-12-01T12:00:00-03:00'))).rejects.toMatchObject({ code: '23P01' })
  })

  it('aceita horários encostados ([10h, 11h) e [11h, 12h))', async () => {
    await expect(comoA((db) => agendar(db, '2026-12-01T11:00:00-03:00', '2026-12-01T12:00:00-03:00'))).resolves.toBeTruthy()
    await expect(comoA((db) => agendar(db, '2026-12-01T09:00:00-03:00', '2026-12-01T10:00:00-03:00'))).resolves.toBeTruthy()
  })

  it('aceita o mesmo horário para outro profissional', async () => {
    await expect(comoA((db) => agendar(db, '2026-12-01T10:00:00-03:00', '2026-12-01T11:00:00-03:00', ids.profissionais[1]))).resolves.toBeTruthy()
  })

  it('agendamento cancelado libera o horário', async () => {
    const { id } = await comoA((db) => agendar(db, '2026-12-02T10:00:00-03:00', '2026-12-02T11:00:00-03:00'))
    await comoA((db) => db.execute(`update agendamentos set status = 'cancelado' where id = $1`, [id]))
    await expect(comoA((db) => agendar(db, '2026-12-02T10:00:00-03:00', '2026-12-02T11:00:00-03:00'))).resolves.toBeTruthy()
  })

  it('vale sob concorrência: de 10 inserções simultâneas no mesmo horário, só uma entra', async () => {
    const tentativas = await Promise.allSettled(
      Array.from({ length: 10 }, () => comoA((db) => agendar(db, '2026-12-03T14:00:00-03:00', '2026-12-03T14:45:00-03:00'))),
    )
    expect(tentativas.filter((t) => t.status === 'fulfilled')).toHaveLength(1)
    for (const t of tentativas.filter((t) => t.status === 'rejected')) {
      expect((t as PromiseRejectedResult).reason).toMatchObject({ code: '23P01' })
    }
  })

  it('recusa período vazio, invertido, infinito ou maior que 8 horas', async () => {
    for (const [i, f] of [
      ['2026-12-04T10:00:00-03:00', '2026-12-04T10:00:00-03:00'],
      ['2026-12-04T10:00:00-03:00', '2026-12-04T19:00:00-03:00'],
    ]) {
      await expect(comoA((db) => agendar(db, i!, f!))).rejects.toMatchObject({ code: '23514' })
    }
    await expect(comoA((db) => agendar(db, '2026-12-04T11:00:00-03:00', '2026-12-04T10:00:00-03:00'))).rejects.toMatchObject({ code: '22000' })
  })
})

describe('transições de status (gatilho)', () => {
  it('não reabre agendamento cancelado nem volta confirmado para agendado', async () => {
    const { id } = await comoA((db) => agendar(db, '2026-12-05T08:00:00-03:00', '2026-12-05T08:30:00-03:00'))
    await comoA((db) => db.execute(`update agendamentos set status = 'confirmado' where id = $1`, [id]))
    await expect(comoA((db) => db.execute(`update agendamentos set status = 'agendado' where id = $1`, [id]))).rejects.toMatchObject({
      code: 'P0001',
      hint: 'transicao_invalida',
    })
    await comoA((db) => db.execute(`update agendamentos set status = 'cancelado' where id = $1`, [id]))
    await expect(comoA((db) => db.execute(`update agendamentos set status = 'confirmado' where id = $1`, [id]))).rejects.toMatchObject({ code: 'P0001' })
  })
})

describe('checagens de cadastro', () => {
  it('recusa preço negativo, duração fora da faixa e telefone fora do padrão', async () => {
    await expect(comoA((db) => db.execute(`insert into servicos (tenant_id, nome, duracao_min, preco_centavos) values (app_tenant(), 'X1', 30, -1)`))).rejects.toMatchObject({ code: '23514' })
    await expect(comoA((db) => db.execute(`insert into servicos (tenant_id, nome, duracao_min, preco_centavos) values (app_tenant(), 'X2', 500, 100)`))).rejects.toMatchObject({ code: '23514' })
    await expect(comoA((db) => db.execute(`insert into clientes (tenant_id, nome, telefone) values (app_tenant(), 'Ana', '81999990000')`))).rejects.toMatchObject({ code: '23514' })
  })
})

describe('total do pedido calculado no banco', () => {
  it('é a soma dos itens, com um único UPDATE por comando', async () => {
    const total = await comoA(async (db) => {
      const p = await db.one<{ id: string }>(`insert into pedidos (tenant_id) values (app_tenant()) returning id`)
      await db.execute(
        `insert into itens_pedido (tenant_id, pedido_id, descricao, quantidade, preco_unitario_centavos)
         values (app_tenant(), $1, 'Baião de dois', 2, 4200), (app_tenant(), $1, 'Suco de cajá', 3, 900)`,
        [p.id],
      )
      const depois = await db.one<{ total_centavos: number; atualizacoes: number }>(
        `select p.total_centavos,
                (select count(*)::int from auditoria a where a.registro_id = p.id and a.acao = 'UPDATE') as atualizacoes
           from pedidos p where id = $1`,
        [p.id],
      )
      await db.execute(`delete from itens_pedido where pedido_id = $1 and descricao = 'Suco de cajá'`, [p.id])
      const final = await db.one<{ total_centavos: number }>('select total_centavos from pedidos where id = $1', [p.id])
      return { ...depois, final: final.total_centavos }
    })
    expect(total).toEqual({ total_centavos: 2 * 4200 + 3 * 900, atualizacoes: 1, final: 8400 })
  })
})

describe('auditoria por gatilho', () => {
  it('registra quem, o quê, antes e depois, com o id da requisição', async () => {
    const usuario = (await amb.admin.query<{ id: string }>(`select id from usuarios where tenant_id = $1 and papel = 'dono'`, [A])).rows[0]!.id
    const id = await withTenant(amb.app, { tenantId: A, usuarioId: usuario, requisicaoId: 'req-teste-1' }, async (db) => {
      const c = await db.one<{ id: string }>(`insert into clientes (tenant_id, nome, telefone) values (app_tenant(), 'Teresa Lins', '+5581990001111') returning id`)
      await db.execute(`update clientes set nome = 'Teresa Lins Moura' where id = $1`, [c.id])
      await db.execute(`update clientes set nome = 'Teresa Lins Moura' where id = $1`, [c.id]) // sem mudança: sem registro
      await db.execute(`delete from clientes where id = $1`, [c.id])
      return c.id
    })
    const { rows } = await amb.admin.query(
      `select acao, usuario_id, requisicao, antes ->> 'nome' as antes, depois ->> 'nome' as depois
         from auditoria where registro_id = $1 order by id`,
      [id],
    )
    expect(rows).toEqual([
      { acao: 'INSERT', usuario_id: usuario, requisicao: 'req-teste-1', antes: null, depois: 'Teresa Lins' },
      { acao: 'UPDATE', usuario_id: usuario, requisicao: 'req-teste-1', antes: 'Teresa Lins', depois: 'Teresa Lins Moura' },
      { acao: 'DELETE', usuario_id: usuario, requisicao: 'req-teste-1', antes: 'Teresa Lins Moura', depois: null },
    ])
  })

  it('nunca grava o hash da senha', async () => {
    const { rows } = await amb.admin.query(`select count(*)::int as n from auditoria where tabela = 'usuarios' and (antes ? 'senha_hash' or depois ? 'senha_hash')`)
    const total = await amb.admin.query(`select count(*)::int as n from auditoria where tabela = 'usuarios'`)
    expect(total.rows[0].n).toBeGreaterThan(0)
    expect(rows[0].n).toBe(0)
  })
})
