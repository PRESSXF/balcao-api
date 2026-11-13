import path from 'node:path'
import pg from 'pg'
import type { GlobalSetupContext } from 'vitest/node'
import { carregarMigracoes, migrar } from '../../src/db/migrator.js'
import { sincronizarPapeis } from '../../src/db/papeis.js'

/**
 * Recria o banco `balcao_teste` do zero a cada execução, aplica as migrações
 * e define as senhas dos papéis. Precisa de TEST_DATABASE_URL apontando para
 * um PostgreSQL 16 com usuário superusuário (veja scripts/test-db.sh).
 */
declare module 'vitest' {
  export interface ProvidedContext {
    urls: { admin: string; app: string; worker: string }
  }
}

export default async function setup({ provide }: GlobalSetupContext) {
  const base = process.env.TEST_DATABASE_URL
  if (!base) {
    throw new Error(
      'TEST_DATABASE_URL não definida. Rode `npm run test:db` (sobe um PostgreSQL de teste) ou defina, por exemplo, ' +
        'TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres',
    )
  }
  const nome = 'balcao_teste'
  const raiz = new pg.Client({ connectionString: base })
  await raiz.connect()
  await raiz.query(`drop database if exists ${nome} with (force)`)
  await raiz.query(`create database ${nome}`)
  await raiz.end()

  const comBanco = (usuario?: string, senha?: string) => {
    const u = new URL(base)
    u.pathname = `/${nome}`
    if (usuario) u.username = usuario
    if (senha) u.password = senha
    return u.toString()
  }
  const urls = {
    admin: comBanco(),
    // Papéis são do cluster inteiro, não do banco. As senhas padrão são as de
    // desenvolvimento para que rodar os testes no mesmo cluster do ambiente
    // local não derrube a API que já está conectada.
    app: comBanco('balcao_app', process.env.TEST_APP_DB_PASSWORD ?? 'balcao_app_dev'),
    worker: comBanco('balcao_worker', process.env.TEST_WORKER_DB_PASSWORD ?? 'balcao_worker_dev'),
  }

  const admin = new pg.Client({ connectionString: urls.admin })
  await admin.connect()
  await migrar(admin, await carregarMigracoes(path.resolve('db/migrations')))
  await sincronizarPapeis(admin, [urls.app, urls.worker])
  await admin.end()

  provide('urls', urls)
}
