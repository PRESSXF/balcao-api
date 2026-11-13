import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '../../src/db/pool.js'
import { verificarWebhook } from '../../src/jobs/assinatura.js'
import { concluirJob, enfileirar, falharJob, pegarJobs, recuperarTravados, type Job } from '../../src/jobs/fila.js'
import { HANDLERS, type Handler } from '../../src/jobs/handlers.js'
import { Worker } from '../../src/jobs/worker.js'
import { A, B, C, abrirAmbiente, idsDe, logSilencioso, resetar, urls, type Ambiente } from './helpers.js'

let amb: Ambiente

beforeAll(() => {
  amb = abrirAmbiente()
})
afterAll(() => amb.fechar())
beforeEach(async () => {
  await resetar(amb.admin)
  await amb.admin.query('delete from outbox; delete from jobs')
})

async function criarJobs(tenant: string, n: number, extra: { executarEm?: Date; tipo?: Job['tipo'] } = {}) {
  return withTenant(amb.app, { tenantId: tenant }, async (db) => {
    const ids: number[] = []
    for (let i = 0; i < n; i++) {
      const id = await enfileirar(db, { tipo: extra.tipo ?? 'entrega_webhook', payload: { evento: 'teste', n: i }, executarEm: extra.executarEm })
      ids.push(id!)
    }
    return ids
  })
}

const estado = async (id: number) =>
  (await amb.admin.query('select status, tentativas, ultimo_erro, executar_em, travado_por from jobs where id = $1', [id])).rows[0]

describe('enfileirar', () => {
  it('com chave de idempotência repetida não cria outro job', async () => {
    const r = await withTenant(amb.app, { tenantId: A }, async (db) => [
      await enfileirar(db, { tipo: 'lembrete_agendamento', payload: {}, chave: 'lembrete:x' }),
      await enfileirar(db, { tipo: 'lembrete_agendamento', payload: {}, chave: 'lembrete:x' }),
    ])
    expect(r[0]).toBeTypeOf('number')
    expect(r[1]).toBeNull()
    // A mesma chave em outra empresa é outro job.
    const outra = await withTenant(amb.app, { tenantId: B }, (db) => enfileirar(db, { tipo: 'lembrete_agendamento', payload: {}, chave: 'lembrete:x' }))
    expect(outra).toBeTypeOf('number')
  })

  it('job enfileirado numa transação desfeita não existe', async () => {
    await expect(
      withTenant(amb.app, { tenantId: A }, async (db) => {
        await enfileirar(db, { tipo: 'entrega_webhook', payload: {} })
        throw new Error('desfaz')
      }),
    ).rejects.toThrow()
    expect((await amb.admin.query('select count(*)::int as n from jobs')).rows[0].n).toBe(0)
  })
})

describe('pegar jobs', () => {
  it('respeita executar_em e marca tentativa e trava', async () => {
    const [agora] = await criarJobs(A, 1)
    const [futuro] = await criarJobs(A, 1, { executarEm: new Date(Date.now() + 60_000) })
    const pegos = await pegarJobs(amb.worker, 'w1', 10)
    expect(pegos.map((j) => j.id)).toEqual([agora])
    expect(pegos[0]).toMatchObject({ status: 'executando', tentativas: 1, tenant_id: A })
    expect((await estado(futuro!)).status).toBe('pendente')
  })

  it('pega de várias empresas na ordem de executar_em', async () => {
    await criarJobs(B, 2)
    await criarJobs(C, 2)
    const pegos = await pegarJobs(amb.worker, 'w1', 10)
    expect(new Set(pegos.map((j) => j.tenant_id))).toEqual(new Set([B, C]))
  })

  it('concorrência: 12 consumidores disputando 300 jobs, nenhum job sai duas vezes', async () => {
    await criarJobs(A, 100)
    await criarJobs(B, 100)
    await criarJobs(C, 100)
    const vistos: number[] = []
    const consumidor = async (nome: string) => {
      for (;;) {
        const lote = await pegarJobs(amb.worker, nome, 7)
        if (lote.length === 0) return
        vistos.push(...lote.map((j) => j.id))
        for (const j of lote) await concluirJob(amb.worker, j, nome, 'ok')
      }
    }
    await Promise.all(Array.from({ length: 12 }, (_, i) => consumidor(`w${i}`)))
    expect(vistos).toHaveLength(300)
    expect(new Set(vistos).size).toBe(300)
    const r = await amb.admin.query(`select status, count(*)::int as n from jobs group by status`)
    expect(r.rows).toEqual([{ status: 'concluido', n: 300 }])
  })
})

describe('falhas, backoff e fila de mortos', () => {
  it('falha volta para pendente com espera; esgotadas as tentativas vai para morto', async () => {
    const [id] = await withTenant(amb.app, { tenantId: A }, async (db) => [await enfileirar(db, { tipo: 'entrega_webhook', payload: {}, maxTentativas: 2 })])
    const [j1] = await pegarJobs(amb.worker, 'w1', 1)
    const antes = Date.now()
    expect(await falharJob(amb.worker, j1!, 'w1', 'HTTP 500', 4000)).toBe('pendente')
    const e1 = await estado(id!)
    expect(e1).toMatchObject({ status: 'pendente', tentativas: 1, ultimo_erro: 'HTTP 500', travado_por: null })
    expect(new Date(e1.executar_em).getTime()).toBeGreaterThanOrEqual(antes + 3500)
    expect(await pegarJobs(amb.worker, 'w1', 1)).toEqual([]) // ainda esperando

    await amb.admin.query('update jobs set executar_em = now() where id = $1', [id])
    const [j2] = await pegarJobs(amb.worker, 'w1', 1)
    expect(j2!.tentativas).toBe(2)
    expect(await falharJob(amb.worker, j2!, 'w1', 'HTTP 503', 8000)).toBe('morto')
    expect(await estado(id!)).toMatchObject({ status: 'morto', tentativas: 2, ultimo_erro: 'HTTP 503' })
    await amb.admin.query('update jobs set executar_em = now() - interval \'1 hour\' where id = $1', [id])
    expect(await pegarJobs(amb.worker, 'w1', 1)).toEqual([])
  })

  it('worker que perdeu a trava não conclui o job de outro', async () => {
    const [id] = await criarJobs(A, 1)
    const [j] = await pegarJobs(amb.worker, 'w-lento', 1)
    await amb.admin.query(`update jobs set travado_em = now() - interval '10 minutes' where id = $1`, [id])
    expect(await recuperarTravados(amb.worker, 300)).toBe(1)
    expect((await estado(id!)).ultimo_erro).toMatch(/trava expirada/)
    const [de_novo] = await pegarJobs(amb.worker, 'w-novo', 1)
    expect(de_novo!.tentativas).toBe(2)
    expect(await concluirJob(amb.worker, j!, 'w-lento', 'tarde demais')).toBe(false)
    expect(await concluirJob(amb.worker, de_novo!, 'w-novo', 'ok')).toBe(true)
  })
})

describe('Worker', () => {
  it('três workers com handler instrumentado processam cada job exatamente uma vez', async () => {
    await criarJobs(A, 40)
    await criarJobs(B, 40)
    const execucoes = new Map<number, number>()
    const handler: Handler = async (job) => {
      execucoes.set(job.id, (execucoes.get(job.id) ?? 0) + 1)
      await new Promise((r) => setTimeout(r, 2 + (job.id % 5)))
      return 'ok'
    }
    const workers = ['a', 'b', 'c'].map(
      (id) => new Worker({ pool: amb.worker, listenUrl: urls().worker, handlers: { entrega_webhook: handler, lembrete_agendamento: handler }, log: logSilencioso, concorrencia: 4, id }),
    )
    await Promise.all(workers.map((w) => w.drenar()))
    expect(execucoes.size).toBe(80)
    expect([...execucoes.values()].every((n) => n === 1)).toBe(true)
    const { rows } = await amb.admin.query(`select travado_por, count(*)::int as n from jobs group by 1`)
    expect(rows).toEqual([{ travado_por: null, n: 80 }])
  })

  it('acorda por NOTIFY: job novo roda em menos de 1 s mesmo com intervalo de 60 s', async () => {
    let feito: (() => void) | null = null
    const executou = new Promise<void>((r) => (feito = r))
    const handler: Handler = async () => {
      feito?.()
      return 'ok'
    }
    const w = new Worker({ pool: amb.worker, listenUrl: urls().worker, handlers: { entrega_webhook: handler, lembrete_agendamento: handler }, log: logSilencioso, intervaloMs: 60_000 })
    await w.start()
    try {
      await new Promise((r) => setTimeout(r, 150)) // worker já dormindo
      const inicio = Date.now()
      await criarJobs(A, 1)
      await executou
      expect(Date.now() - inicio).toBeLessThan(1000)
    } finally {
      await w.stop()
    }
  })

  it('stop() espera o job em andamento terminar', async () => {
    let terminou = false
    const handler: Handler = async () => {
      await new Promise((r) => setTimeout(r, 300))
      terminou = true
      return 'ok'
    }
    await criarJobs(A, 1)
    const w = new Worker({ pool: amb.worker, listenUrl: urls().worker, handlers: { entrega_webhook: handler, lembrete_agendamento: handler }, log: logSilencioso })
    await w.start()
    await new Promise((r) => setTimeout(r, 100))
    await w.stop()
    expect(terminou).toBe(true)
    expect((await amb.admin.query(`select status from jobs`)).rows[0].status).toBe('concluido')
  })
})

describe('handlers', () => {
  it('lembrete: grava a mensagem de WhatsApp na outbox uma única vez', async () => {
    const ids = await idsDe(amb.admin, A)
    const ag = await withTenant(amb.app, { tenantId: A }, async (db) => {
      const a = await db.one<{ id: string; inicio: Date }>(
        `insert into agendamentos (tenant_id, profissional_id, cliente_id, servico_id, periodo, preco_centavos)
         values (app_tenant(), $1, $2, $3, tstzrange('2026-12-15 14:30-03', '2026-12-15 15:00-03'), 25000) returning id, lower(periodo) as inicio`,
        [ids.profissionais[1], ids.clientes[0], ids.servicos[0]],
      )
      await enfileirar(db, { tipo: 'lembrete_agendamento', payload: { agendamento_id: a.id, inicio: a.inicio.toISOString() } })
      return a
    })
    const w = new Worker({ pool: amb.worker, listenUrl: urls().worker, handlers: HANDLERS, log: logSilencioso })
    await w.drenar()
    // Rodar o mesmo lembrete de novo (como num reenvio) não duplica a mensagem.
    await withTenant(amb.app, { tenantId: A }, (db) => enfileirar(db, { tipo: 'lembrete_agendamento', payload: { agendamento_id: ag.id } }))
    await w.drenar()

    const { rows } = await amb.admin.query(`select canal, destino, conteudo ->> 'texto' as texto from outbox where tenant_id = $1`, [A])
    expect(rows).toHaveLength(1)
    expect(rows[0].canal).toBe('whatsapp')
    expect(rows[0].destino).toMatch(/^\+55819/)
    expect(rows[0].texto).toMatch(/^Olá, \S+! Lembrete da Clínica Boa Vista: Avaliação nutricional com Dra\. Helena Cavalcanti em 15\/12 às 14:30\./)
    const res = await amb.admin.query(`select resultado from jobs order by id`)
    expect(res.rows.map((r) => r.resultado)).toEqual(['enviado', 'já enviado antes (efeito idempotente)'])
  })

  it('lembrete de agendamento cancelado é ignorado', async () => {
    const id = (await amb.admin.query(`select id from agendamentos where tenant_id = $1 and status = 'agendado' limit 1`, [A])).rows[0].id
    await amb.admin.query(`update agendamentos set status = 'cancelado' where id = $1`, [id])
    await withTenant(amb.app, { tenantId: A }, (db) => enfileirar(db, { tipo: 'lembrete_agendamento', payload: { agendamento_id: id } }))
    await new Worker({ pool: amb.worker, listenUrl: urls().worker, handlers: HANDLERS, log: logSilencioso }).drenar()
    expect((await amb.admin.query('select resultado from jobs')).rows[0].resultado).toBe('ignorado: agendamento cancelado')
    expect((await amb.admin.query('select count(*)::int as n from outbox')).rows[0].n).toBe(0)
  })

  describe('webhook', () => {
    let servidor: Server
    let recebidos: { corpo: string; headers: IncomingMessage['headers'] }[]
    let respostas: number[]

    beforeAll(async () => {
      servidor = createServer((req, res) => {
        let corpo = ''
        req.on('data', (c) => (corpo += c))
        req.on('end', () => {
          recebidos.push({ corpo, headers: req.headers })
          res.writeHead(respostas.shift() ?? 200).end()
        })
      })
      await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r))
    })
    afterAll(() => new Promise<void>((r) => servidor.close(() => r())))
    beforeEach(() => {
      recebidos = []
      respostas = []
    })

    it('entrega com assinatura HMAC válida; falha 500 é tentada de novo com backoff', async () => {
      const porta = (servidor.address() as AddressInfo).port
      const segredo = 'whsec_teste_com_mais_de_24_caracteres'
      await amb.admin.query('update tenants set webhook_url = $2, webhook_segredo = $3 where id = $1', [A, `http://127.0.0.1:${porta}/hook`, segredo])
      respostas = [500]
      const [id] = await withTenant(amb.app, { tenantId: A }, async (db) => [
        await enfileirar(db, { tipo: 'entrega_webhook', payload: { evento: 'agendamento.criado', ocorrido_em: '2026-11-16T12:00:00.000Z', dados: { x: 1 } } }),
      ])
      const w = new Worker({ pool: amb.worker, listenUrl: urls().worker, handlers: HANDLERS, log: logSilencioso, backoff: { baseMs: 50, maxMs: 100 } })
      await w.drenar()
      expect(await estado(id!)).toMatchObject({ status: 'pendente', tentativas: 1, ultimo_erro: `HTTP 500 de 127.0.0.1:${porta}` })

      await new Promise((r) => setTimeout(r, 150))
      await w.drenar()
      expect((await estado(id!)).status).toBe('concluido')
      expect(recebidos).toHaveLength(2)
      const ultimo = recebidos[1]!
      expect(ultimo.headers['x-balcao-evento']).toBe('agendamento.criado')
      expect(ultimo.headers['x-balcao-tentativa']).toBe('2')
      expect(ultimo.headers['x-balcao-entrega']).toBe(`evt_${id}`)
      expect(verificarWebhook(ultimo.corpo, ultimo.headers['x-balcao-assinatura'] as string, segredo)).toBe(true)
      expect(verificarWebhook(ultimo.corpo, ultimo.headers['x-balcao-assinatura'] as string, 'segredo-errado-com-24-caracteres')).toBe(false)
      expect(JSON.parse(ultimo.corpo)).toMatchObject({ id: `evt_${id}`, evento: 'agendamento.criado', empresa_id: A, dados: { x: 1 } })
      // Mesmo corpo nas duas tentativas: o receptor pode deduplicar pelo id.
      expect(recebidos[0]!.corpo).toBe(ultimo.corpo)
      const out = await amb.admin.query(`select canal, status_http from outbox where job_id = $1`, [id])
      expect(out.rows).toEqual([{ canal: 'webhook', status_http: 200 }])
    })

    it('destino fora do ar esgota as tentativas e vai para morto', async () => {
      await amb.admin.query(`update tenants set webhook_url = 'http://127.0.0.1:9/fechado', webhook_segredo = 'whsec_teste_com_mais_de_24_caracteres' where id = $1`, [A])
      const [id] = await withTenant(amb.app, { tenantId: A }, async (db) => [await enfileirar(db, { tipo: 'entrega_webhook', payload: { evento: 'x' }, maxTentativas: 3 })])
      const w = new Worker({ pool: amb.worker, listenUrl: urls().worker, handlers: HANDLERS, log: logSilencioso, backoff: { baseMs: 20, maxMs: 40 } })
      for (let i = 0; i < 3; i++) {
        await w.drenar()
        await new Promise((r) => setTimeout(r, 60))
      }
      expect(await estado(id!)).toMatchObject({ status: 'morto', tentativas: 3 })
      expect((await estado(id!)).ultimo_erro).toMatch(/ECONNREFUSED/)
    })

    it('empresa sem webhook: job concluído como ignorado', async () => {
      const [id] = await criarJobs(B, 1)
      await new Worker({ pool: amb.worker, listenUrl: urls().worker, handlers: HANDLERS, log: logSilencioso }).drenar()
      expect((await amb.admin.query('select status, resultado from jobs where id = $1', [id])).rows[0]).toEqual({
        status: 'concluido',
        resultado: 'ignorado: empresa sem webhook configurado',
      })
    })
  })
})
