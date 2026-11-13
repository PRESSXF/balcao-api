import { createServer } from 'node:http'
import { pino } from 'pino'
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client'
import { carregarConfig } from './config.js'
import { createPool } from './db/pool.js'
import { HANDLERS } from './jobs/handlers.js'
import { Worker } from './jobs/worker.js'

/**
 * Processo do worker. Expõe /health e /metrics numa porta interna
 * (WORKER_METRICS_PORT) e encerra com calma no SIGTERM: termina os jobs em
 * andamento antes de sair. Pode rodar em várias réplicas.
 */
async function main(): Promise<void> {
  const config = carregarConfig()
  const log = pino({
    level: config.logNivel,
    base: { processo: 'worker' },
    ...(config.ambiente === 'development' && process.stdout.isTTY ? { transport: { target: 'pino-pretty' } } : {}),
  })
  const pool = createPool(config.workerDatabaseUrl, { max: config.worker.concorrencia + 2, nome: 'balcao-worker' })

  const registro = new Registry()
  collectDefaultMetrics({ register: registro, prefix: 'balcao_worker_' })
  const processados = new Counter({
    name: 'balcao_jobs_processados_total',
    help: 'Jobs processados por tipo e resultado',
    labelNames: ['tipo', 'resultado'] as const,
    registers: [registro],
  })
  const duracao = new Histogram({
    name: 'balcao_job_duracao_segundos',
    help: 'Duração da execução dos jobs',
    labelNames: ['tipo'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [registro],
  })

  const worker = new Worker({
    pool,
    listenUrl: config.workerDatabaseUrl,
    handlers: HANDLERS,
    log,
    concorrencia: config.worker.concorrencia,
    intervaloMs: config.worker.intervaloMs,
    travaTimeoutSeg: config.worker.travaTimeoutSeg,
    backoff: { baseMs: config.worker.backoffBaseMs, maxMs: config.worker.backoffMaxMs },
    latenciaWhatsappMs: config.worker.latenciaWhatsappMs,
    aoTerminar: (job, resultado, ms) => {
      processados.inc({ tipo: job.tipo, resultado })
      duracao.observe({ tipo: job.tipo }, ms / 1000)
    },
  })

  const http = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}')
    } else if (req.url === '/metrics') {
      registro.metrics().then(
        (m) => res.writeHead(200, { 'content-type': registro.contentType }).end(m),
        () => res.writeHead(500).end(),
      )
    } else {
      res.writeHead(404).end()
    }
  })

  await worker.start()
  http.listen(config.worker.portaMetricas, config.host)
  log.info({ id: worker.id, concorrencia: config.worker.concorrencia, porta_metricas: config.worker.portaMetricas }, 'worker pronto')

  let encerrando = false
  const encerrar = async (sinal: string) => {
    if (encerrando) return
    encerrando = true
    log.info({ sinal }, 'encerrando o worker: terminando jobs em andamento')
    const limite = setTimeout(() => {
      log.error('encerramento passou de 25 s; saindo à força (jobs travados voltam à fila pelo tempo limite)')
      process.exit(1)
    }, 25_000)
    limite.unref()
    await worker.stop()
    http.close()
    await pool.end()
    log.info('worker encerrado')
    process.exit(0)
  }
  process.on('SIGTERM', () => void encerrar('SIGTERM'))
  process.on('SIGINT', () => void encerrar('SIGINT'))
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
