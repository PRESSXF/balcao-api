import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import pg from 'pg'
import type { Logger } from 'pino'
import { calcularEspera, concluirJob, falharJob, pegarJobs, proximoAgendado, recuperarTravados, type Job, type TipoJob } from './fila.js'
import type { ContextoJob, Handler } from './handlers.js'

export interface OpcoesWorker {
  pool: pg.Pool
  /** URL para a conexão dedicada ao LISTEN (fora do pool). */
  listenUrl: string
  handlers: Record<TipoJob, Handler>
  log: Logger
  concorrencia?: number
  intervaloMs?: number
  travaTimeoutSeg?: number
  backoff?: { baseMs: number; maxMs: number }
  latenciaWhatsappMs?: number
  fetch?: typeof fetch
  id?: string
  aoTerminar?: (job: Job, resultado: 'concluido' | 'pendente' | 'morto', duracaoMs: number) => void
}

/**
 * Worker da fila. Um laço que:
 * 1. pega até N jobs livres (SKIP LOCKED) e executa em paralelo;
 * 2. sem trabalho, dorme até o primeiro destes: NOTIFY de job novo, horário do
 *    próximo job agendado ou o intervalo de segurança;
 * 3. de tempos em tempos devolve à fila jobs travados por worker que morreu.
 *
 * stop() para de pegar jobs, espera os que estão rodando e fecha as conexões.
 */
export class Worker {
  readonly id: string
  private emExecucao = new Set<Promise<void>>()
  private parando = false
  private acordar: (() => void) | null = null
  private listener: pg.Client | null = null
  private laco: Promise<void> | null = null
  private ultimaRecuperacao = 0
  private readonly o: Required<Omit<OpcoesWorker, 'id' | 'aoTerminar'>> & Pick<OpcoesWorker, 'aoTerminar'>

  constructor(opcoes: OpcoesWorker) {
    this.id = opcoes.id ?? `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`
    this.o = {
      concorrencia: 4,
      intervaloMs: 5000,
      travaTimeoutSeg: 300,
      backoff: { baseMs: 2000, maxMs: 600_000 },
      latenciaWhatsappMs: 0,
      fetch: globalThis.fetch,
      ...opcoes,
    }
  }

  async start(): Promise<void> {
    await this.conectarListener()
    this.laco = this.rodar()
  }

  private async conectarListener(): Promise<void> {
    const client = new pg.Client({ connectionString: this.o.listenUrl, application_name: `balcao-worker-listen` })
    client.on('notification', () => this.despertar())
    client.on('error', (err) => {
      this.o.log.warn({ err }, 'conexão de LISTEN caiu; reconectando')
      this.listener = null
      if (!this.parando) setTimeout(() => void this.conectarListener().catch(() => {}), 1000)
    })
    await client.connect()
    await client.query('listen balcao_jobs')
    this.listener = client
  }

  private despertar(): void {
    const a = this.acordar
    this.acordar = null
    a?.()
  }

  private async rodar(): Promise<void> {
    while (!this.parando) {
      try {
        const pegou = await this.ciclo()
        if (pegou === 0 && !this.parando) await this.dormir()
      } catch (err) {
        this.o.log.error({ err }, 'erro no laço do worker')
        await this.dormir(1000)
      }
    }
  }

  /** Um ciclo: recupera travados (no máximo a cada 30 s) e pega o que couber. Devolve quantos pegou. */
  async ciclo(): Promise<number> {
    if (Date.now() - this.ultimaRecuperacao > 30_000) {
      this.ultimaRecuperacao = Date.now()
      const n = await recuperarTravados(this.o.pool, this.o.travaTimeoutSeg)
      if (n > 0) this.o.log.warn({ jobs: n }, 'jobs travados devolvidos à fila')
    }
    const livres = this.o.concorrencia - this.emExecucao.size
    if (livres <= 0) {
      await Promise.race(this.emExecucao)
      return 1
    }
    const jobs = await pegarJobs(this.o.pool, this.id, livres)
    for (const job of jobs) {
      const p = this.executar(job).finally(() => {
        this.emExecucao.delete(p)
        this.despertar()
      })
      this.emExecucao.add(p)
    }
    return jobs.length
  }

  /** Para testes: processa tudo o que estiver pronto agora e espera terminar. */
  async drenar(): Promise<number> {
    let total = 0
    for (;;) {
      const n = await this.ciclo()
      if (n === 0 && this.emExecucao.size === 0) return total
      total += n
      if (n === 0) await Promise.race(this.emExecucao)
    }
  }

  private async dormir(maxMs = this.o.intervaloMs): Promise<void> {
    let espera = maxMs
    if (this.emExecucao.size === 0) {
      const proximo = await proximoAgendado(this.o.pool).catch(() => null)
      if (proximo) espera = Math.max(50, Math.min(maxMs, proximo.getTime() - Date.now()))
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.acordar = null
        resolve()
      }, espera)
      this.acordar = () => {
        clearTimeout(t)
        resolve()
      }
    })
  }

  private async executar(job: Job): Promise<void> {
    const inicio = performance.now()
    const log = this.o.log.child({ job: job.id, tipo: job.tipo, tenant: job.tenant_id, tentativa: job.tentativas })
    const ctx: ContextoJob = { pool: this.o.pool, latenciaWhatsappMs: this.o.latenciaWhatsappMs, fetch: this.o.fetch }
    try {
      const handler = this.o.handlers[job.tipo]
      if (!handler) throw new Error(`tipo de job sem handler: ${job.tipo}`)
      const resultado = await handler(job, ctx)
      await concluirJob(this.o.pool, job, this.id, resultado)
      const ms = performance.now() - inicio
      log.info({ resultado, ms: Math.round(ms) }, 'job concluído')
      this.o.aoTerminar?.(job, 'concluido', ms)
    } catch (err) {
      const mensagem = err instanceof Error ? (err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message) : String(err)
      const espera = calcularEspera(job.tentativas, this.o.backoff)
      const status = await falharJob(this.o.pool, job, this.id, mensagem, espera).catch(() => null)
      const ms = performance.now() - inicio
      if (status === 'morto') log.error({ erro: mensagem }, 'job esgotou as tentativas e foi para "morto"')
      else log.warn({ erro: mensagem, nova_tentativa_em_ms: espera }, 'job falhou; nova tentativa agendada')
      this.o.aoTerminar?.(job, status === 'morto' ? 'morto' : 'pendente', ms)
    }
  }

  async stop(): Promise<void> {
    this.parando = true
    this.despertar()
    await this.laco
    await Promise.allSettled(this.emExecucao)
    const l = this.listener
    this.listener = null
    await l?.end().catch(() => {})
  }
}
