import path from 'node:path'
import { pino } from 'pino'
import type pg from 'pg'
import { inject } from 'vitest'
import { carregarConfig, type Config } from '../../src/config.js'
import { createPool } from '../../src/db/pool.js'
import { EMPRESAS_DEMO, semear } from '../../src/db/seed.js'
import { construirApp, type App } from '../../src/http/app.js'

export { EMPRESAS_DEMO }
export const A = EMPRESAS_DEMO.clinica
export const B = EMPRESAS_DEMO.salao
export const C = EMPRESAS_DEMO.restaurante

export const urls = () => inject('urls')

export interface Ambiente {
  admin: pg.Pool
  app: pg.Pool
  worker: pg.Pool
  fechar(): Promise<void>
}

export function abrirAmbiente(): Ambiente {
  const u = urls()
  const admin = createPool(u.admin, { max: 4, nome: 'teste-admin' })
  const app = createPool(u.app, { max: 12, nome: 'teste-app' })
  const worker = createPool(u.worker, { max: 12, nome: 'teste-worker' })
  return {
    admin,
    app,
    worker,
    async fechar() {
      await Promise.all([admin.end(), app.end(), worker.end()])
    },
  }
}

const TABELAS = 'outbox, jobs, auditoria, itens_pedido, pedidos, agendamentos, refresh_tokens, usuarios, clientes, servicos, profissionais, tenants'

/** Apaga tudo e semeia as três empresas de demonstração com "hoje" fixo. */
export async function resetar(admin: pg.Pool, hoje = '2026-11-16'): Promise<void> {
  await admin.query(`truncate ${TABELAS} restart identity cascade`)
  const client = await admin.connect()
  try {
    await semear(client, { hoje, urlWebhookDemo: 'http://127.0.0.1:9/demo/webhooks' })
  } finally {
    client.release()
  }
}

export function configTeste(extra: Partial<Config> = {}): Config {
  process.env.NODE_ENV = 'test'
  const base = carregarConfig()
  return {
    ...base,
    databaseUrl: urls().app,
    workerDatabaseUrl: urls().worker,
    adminDatabaseUrl: urls().admin,
    loginLimitePorMinuto: 1000,
    modoDemo: true,
    pastaMigracoes: path.resolve('db/migrations'),
    pastaConsole: path.resolve('.tmp/sem-console'),
    ...extra,
  }
}

export async function criarApp(pool: pg.Pool, extra: Partial<Config> = {}): Promise<App> {
  const app = await construirApp({ pool, config: configTeste(extra) })
  await app.ready()
  return app
}

export const logSilencioso = pino({ level: 'silent' })

export async function login(app: App, empresa: string, email: string, senha = 'balcao123') {
  const r = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { empresa, email, senha } })
  if (r.statusCode !== 200) throw new Error(`login falhou: ${r.statusCode} ${r.body}`)
  return r.json<{ acesso: string; renovacao: string; usuario: { id: string }; empresa: { id: string } }>()
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` })

/** Ids úteis de uma empresa, lidos como admin. */
export async function idsDe(admin: pg.Pool, tenantId: string) {
  const q = async (sql: string) => (await admin.query<{ id: string }>(sql, [tenantId])).rows.map((r) => r.id)
  return {
    profissionais: await q('select id from profissionais where tenant_id = $1 order by nome collate "C"'),
    clientes: await q('select id from clientes where tenant_id = $1 order by nome collate "C"'),
    servicos: await q('select id from servicos where tenant_id = $1 order by nome collate "C"'),
  }
}
