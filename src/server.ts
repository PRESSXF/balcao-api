import { carregarConfig } from './config.js'
import { createPool } from './db/pool.js'
import { construirApp } from './http/app.js'

/**
 * Processo da API. Encerramento gracioso: no SIGTERM (docker stop, deploy),
 * para de aceitar conexões, termina as requisições em andamento e fecha o pool.
 */
async function main(): Promise<void> {
  const config = carregarConfig()
  const pool = createPool(config.databaseUrl, { max: config.poolMax, nome: 'balcao-api' })
  const app = await construirApp({
    pool,
    config,
    metricasPadrao: true,
    logger: {
      level: config.logNivel,
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'body.senha', 'body.renovacao'], censor: '[oculto]' },
      ...(config.ambiente === 'development' && process.stdout.isTTY ? { transport: { target: 'pino-pretty' } } : {}),
    },
  })

  let encerrando = false
  const encerrar = async (sinal: string) => {
    if (encerrando) return
    encerrando = true
    app.log.info({ sinal }, 'encerrando a API')
    const limite = setTimeout(() => {
      app.log.error('encerramento passou de 10 s; saindo à força')
      process.exit(1)
    }, 10_000)
    limite.unref()
    try {
      await app.close()
      await pool.end()
      process.exit(0)
    } catch (err) {
      app.log.error({ err }, 'erro ao encerrar')
      process.exit(1)
    }
  }
  process.on('SIGTERM', () => void encerrar('SIGTERM'))
  process.on('SIGINT', () => void encerrar('SIGINT'))

  await app.listen({ host: config.host, port: config.porta })
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
