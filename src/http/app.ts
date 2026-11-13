import { existsSync } from 'node:fs'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import Fastify, { type FastifyError, type FastifyServerOptions, type preHandlerHookHandler } from 'fastify'
import type pg from 'pg'
import { ErroToken, verificarAcesso, type Papel } from '../auth/jwt.js'
import type { Config } from '../config.js'
import { withTenant, type Db } from '../db/pool.js'
import { ErroApi, traduzirErroBanco, traduzirErroValidacao } from './erros.js'
import { ErroResposta } from './esquemas.js'
import { criarMetricasApi, type MetricasApi } from './metricas.js'
import { rotasAgenda } from './routes/agenda.js'
import { rotasAuth } from './routes/auth.js'
import { rotasCadastros } from './routes/cadastros.js'
import { rotasDemo } from './routes/demo.js'
import { rotasOperacao } from './routes/operacao.js'
import { rotasPainel } from './routes/painel.js'
import { rotasPedidos } from './routes/pedidos.js'

export interface Autenticado {
  usuarioId: string
  tenantId: string
  papel: Papel
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: Autenticado | null
    /** Transação com a empresa do usuário autenticado (RLS). */
    db<T>(fn: (db: Db) => Promise<T>): Promise<T>
  }
  interface FastifyInstance {
    pool: pg.Pool
    config: Config
    metricas: MetricasApi
    exigir(...papeis: Papel[]): preHandlerHookHandler
  }
}

export interface Dependencias {
  pool: pg.Pool
  config: Config
  logger?: FastifyServerOptions['logger']
  metricasPadrao?: boolean
}

export async function construirApp(deps: Dependencias) {
  const { pool, config } = deps
  let contador = 0
  const app = Fastify({
    logger: deps.logger ?? false,
    genReqId: (req) => {
      const recebido = req.headers['x-request-id']
      return typeof recebido === 'string' && /^[\w.-]{1,64}$/.test(recebido) ? recebido : `req-${(++contador).toString(36)}`
    },
    trustProxy: true,
    ajv: { customOptions: { allErrors: true, removeAdditional: false, coerceTypes: 'array', useDefaults: true } },
    bodyLimit: 64 * 1024,
  }).withTypeProvider<TypeBoxTypeProvider>()

  app.decorate('pool', pool)
  app.decorate('config', config)
  app.decorate('metricas', criarMetricasApi(pool, { padrao: deps.metricasPadrao ?? false }))
  app.addSchema(ErroResposta)

  // ---------------------------------------------------------------- autenticação
  app.decorateRequest('auth', null)
  app.decorateRequest('db', function <T>(this: { auth: Autenticado | null; id: string }, fn: (db: Db) => Promise<T>) {
    if (!this.auth) throw new ErroApi(401, 'nao_autenticado', 'Faça login para continuar.')
    return withTenant(pool, { tenantId: this.auth.tenantId, usuarioId: this.auth.usuarioId, requisicaoId: this.id }, fn)
  })

  app.decorate('exigir', (...papeis: Papel[]): preHandlerHookHandler => {
    return async (req) => {
      const cabecalho = req.headers.authorization
      if (!cabecalho?.startsWith('Bearer ')) {
        throw new ErroApi(401, 'nao_autenticado', 'Envie o token de acesso no cabeçalho Authorization: Bearer <token>.')
      }
      try {
        const c = verificarAcesso(cabecalho.slice(7), config.jwtSegredo)
        req.auth = { usuarioId: c.sub, tenantId: c.tid, papel: c.papel }
      } catch (err) {
        if (err instanceof ErroToken) throw new ErroApi(401, err.codigo, err.message)
        throw err
      }
      if (papeis.length > 0 && !papeis.includes(req.auth.papel)) {
        throw new ErroApi(403, 'papel_insuficiente', `Esta ação exige o papel: ${papeis.join(' ou ')}.`)
      }
    }
  })

  // ---------------------------------------------------------------- erros
  app.setErrorHandler((error: FastifyError | ErroApi | Error, req, reply) => {
    let erro: ErroApi
    if (error instanceof ErroApi) {
      erro = error
    } else if ('validation' in error && error.validation) {
      const detalhes = error.validation.map((v) => traduzirErroValidacao(v as never, error.validationContext))
      erro = new ErroApi(400, 'validacao', 'Alguns campos estão inválidos.', detalhes)
    } else {
      const doBanco = traduzirErroBanco(error)
      const status = 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500
      if (doBanco) erro = doBanco
      else if (status === 429) erro = new ErroApi(429, 'muitas_requisicoes', 'Muitas requisições. Aguarde um pouco.')
      else if (status === 413) erro = new ErroApi(413, 'corpo_grande', 'O corpo da requisição é grande demais.')
      else if (status === 415) erro = new ErroApi(415, 'tipo_nao_suportado', 'Envie o corpo como application/json.')
      else if (status >= 400 && status < 500) erro = new ErroApi(status, 'requisicao_invalida', 'Requisição inválida: confira o corpo e os cabeçalhos.')
      else erro = new ErroApi(500, 'erro_interno', 'Erro interno. Tente novamente; se persistir, informe o id da requisição.')
    }
    if (erro.statusCode >= 500) req.log.error({ err: error }, 'erro interno')
    else req.log.info({ codigo: erro.codigo, status: erro.statusCode }, 'requisição recusada')
    return reply.status(erro.statusCode).send({
      erro: { codigo: erro.codigo, mensagem: erro.message, ...(erro.detalhes ? { detalhes: erro.detalhes } : {}) },
      requisicao: req.id,
    })
  })

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({
      erro: { codigo: 'rota_inexistente', mensagem: `Rota ${req.method} ${req.url.split('?')[0]} não existe.` },
      requisicao: req.id,
    }),
  )

  // ---------------------------------------------------------------- métricas
  app.addHook('onResponse', async (req, reply) => {
    const rota = req.routeOptions.url ?? 'desconhecida'
    if (rota === '/metrics') return
    app.metricas.duracao.observe(
      { metodo: req.method, rota, status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    )
  })

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id)
  })

  // ---------------------------------------------------------------- plugins
  await app.register(fastifyRateLimit, { global: false })

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Balcão API',
        version: '1.0.0',
        description:
          'Back-end multiempresa para pequenos negócios de serviço. Toda rota autenticada roda numa transação ' +
          'com a empresa do token definida no PostgreSQL (Row Level Security). Erros seguem o esquema `Erro`, ' +
          'com mensagens em português.',
      },
      servers: [{ url: '/' }],
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
      tags: [
        { name: 'autenticação', description: 'Login, renovação rotativa e saída' },
        { name: 'agenda', description: 'Agenda do dia e agendamentos sem sobreposição' },
        { name: 'cadastros', description: 'Clientes, serviços, profissionais e usuários' },
        { name: 'pedidos', description: 'Pedidos com chave de idempotência' },
        { name: 'painel', description: 'Fila de jobs, mensagens enviadas e auditoria' },
        { name: 'operação', description: 'Saúde, prontidão e métricas' },
      ],
    },
    refResolver: { buildLocalReference: (json, _base, _frag, i) => (typeof json.$id === 'string' ? json.$id : `def-${i}`) },
  })
  await app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', defaultModelsExpandDepth: 0, tryItOutEnabled: true, persistAuthorization: true },
    theme: { title: 'Balcão API · documentação' },
  })

  await app.register(rotasOperacao)
  await app.register(rotasAuth, { prefix: '/v1' })
  await app.register(rotasCadastros, { prefix: '/v1' })
  await app.register(rotasAgenda, { prefix: '/v1' })
  await app.register(rotasPedidos, { prefix: '/v1' })
  await app.register(rotasPainel, { prefix: '/v1' })
  if (config.modoDemo) await app.register(rotasDemo, { prefix: '/demo' })

  // Console web estático (gerado por `npm run build:console`).
  if (existsSync(config.pastaConsole)) {
    await app.register(fastifyStatic, { root: config.pastaConsole, prefix: '/', wildcard: false, index: ['index.html'] })
  }

  return app
}

export type App = Awaited<ReturnType<typeof construirApp>>
