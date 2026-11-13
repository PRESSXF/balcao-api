import pg from 'pg'

// int8 (bigint) vira number: ids da fila e contagens cabem com folga em 2^53.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10))

export type Linha = Record<string, unknown>

/**
 * Camada mínima de consulta tipada. O SQL fica explícito no código; o tipo
 * genérico descreve a linha que a consulta devolve.
 */
export interface Db {
  query<T extends Linha = Linha>(sql: string, params?: unknown[]): Promise<T[]>
  one<T extends Linha = Linha>(sql: string, params?: unknown[]): Promise<T>
  maybeOne<T extends Linha = Linha>(sql: string, params?: unknown[]): Promise<T | null>
  execute(sql: string, params?: unknown[]): Promise<number>
}

type Executor = Pick<pg.PoolClient, 'query'> | pg.Pool

export function wrap(executor: Executor): Db {
  return {
    async query<T extends Linha>(sql: string, params: unknown[] = []) {
      const r = await executor.query(sql, params)
      return r.rows as T[]
    },
    async one<T extends Linha>(sql: string, params: unknown[] = []) {
      const r = await executor.query(sql, params)
      if (r.rows.length !== 1) throw new Error(`Esperava 1 linha, veio ${r.rows.length}`)
      return r.rows[0] as T
    },
    async maybeOne<T extends Linha>(sql: string, params: unknown[] = []) {
      const r = await executor.query(sql, params)
      return (r.rows[0] as T | undefined) ?? null
    },
    async execute(sql: string, params: unknown[] = []) {
      const r = await executor.query(sql, params)
      return r.rowCount ?? 0
    },
  }
}

export function createPool(connectionString: string, opts: { max?: number; nome?: string } = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    application_name: opts.nome ?? 'balcao',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })
  // Erro numa conexão ociosa (banco reiniciou, por exemplo) não pode derrubar o processo.
  pool.on('error', () => {})
  return pool
}

export interface ContextoEmpresa {
  tenantId: string
  usuarioId?: string | null
  requisicaoId?: string | null
}

/**
 * Executa `fn` numa transação com a empresa definida por set_config(..., true),
 * o equivalente parametrizável de SET LOCAL. O valor vale só até o COMMIT ou
 * ROLLBACK, então a conexão volta limpa para o pool mesmo se `fn` falhar.
 */
export async function withTenant<T>(pool: pg.Pool, ctx: ContextoEmpresa, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let quebrada = false
  try {
    await client.query('begin')
    await client.query(
      `select set_config('app.tenant_id', $1, true),
              set_config('app.user_id', $2, true),
              set_config('app.request_id', $3, true)`,
      [ctx.tenantId, ctx.usuarioId ?? '', ctx.requisicaoId ?? ''],
    )
    const resultado = await fn(wrap(client))
    await client.query('commit')
    return resultado
  } catch (err) {
    try {
      await client.query('rollback')
    } catch {
      quebrada = true
    }
    throw err
  } finally {
    client.release(quebrada)
  }
}

/** Transação sem empresa definida (login começa assim, pelo diretório público). */
export async function withTransaction<T>(pool: pg.Pool, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let quebrada = false
  try {
    await client.query('begin')
    const r = await fn(wrap(client))
    await client.query('commit')
    return r
  } catch (err) {
    try {
      await client.query('rollback')
    } catch {
      quebrada = true
    }
    throw err
  } finally {
    client.release(quebrada)
  }
}

export function isPgError(err: unknown): err is pg.DatabaseError {
  return err instanceof pg.DatabaseError
}
