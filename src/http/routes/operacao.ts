import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { carregarMigracoes } from '../../db/migrator.js'

/**
 * /health: o processo está de pé (para o orquestrador reiniciar se não estiver).
 * /ready: o banco responde e o esquema está na versão que este código espera
 *         (para o balanceador só mandar tráfego quando der para atender).
 * /metrics: formato texto do Prometheus.
 */
export const rotasOperacao: FastifyPluginAsyncTypebox = async (app) => {
  const migracoes = await carregarMigracoes(app.config.pastaMigracoes).catch(() => [])
  const versaoEsperada = migracoes.at(-1)?.versao ?? null

  app.get(
    '/health',
    { schema: { tags: ['operação'], summary: 'Processo vivo', response: { 200: Type.Object({ status: Type.Literal('ok') }) } } },
    async () => ({ status: 'ok' as const }),
  )

  app.get(
    '/ready',
    {
      schema: {
        tags: ['operação'],
        summary: 'Pronto para receber tráfego (banco e migrações)',
        response: {
          200: Type.Object({ status: Type.String(), banco_ms: Type.Number(), migracao: Type.Union([Type.String(), Type.Null()]) }),
          503: Type.Object({ status: Type.String(), motivo: Type.String() }),
        },
      },
    },
    async (_req, reply) => {
      const inicio = performance.now()
      try {
        const { rows } = await app.pool.query<{ versao: string | null }>('select max(versao) as versao from schema_migrations')
        const versao = rows[0]?.versao ?? null
        const ms = Math.round((performance.now() - inicio) * 10) / 10
        if (versaoEsperada && versao !== versaoEsperada) {
          return reply.status(503).send({ status: 'indisponivel', motivo: `banco na migração ${versao ?? 'nenhuma'}, código espera ${versaoEsperada}` })
        }
        return { status: 'pronto', banco_ms: ms, migracao: versao }
      } catch (err) {
        return reply.status(503).send({ status: 'indisponivel', motivo: `banco inacessível: ${(err as Error).message}` })
      }
    },
  )

  app.get('/metrics', { schema: { tags: ['operação'], summary: 'Métricas (Prometheus)', hide: false } }, async (_req, reply) => {
    const corpo = await app.metricas.registro.metrics()
    return reply.type(app.metricas.registro.contentType).send(corpo)
  })
}
