import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type pg from 'pg'

/**
 * Executor de migrações SQL versionadas, sem ORM.
 *
 * - Arquivos `NNNN_nome.sql` em ordem numérica, cada um na sua transação.
 * - `schema_migrations` guarda versão, nome e SHA-256 do conteúdo.
 * - Rodar de novo não faz nada (idempotente).
 * - Se um arquivo já aplicado mudou, ou sumiu, nada roda: migração aplicada
 *   não se edita, cria-se outra.
 * - Um advisory lock impede dois processos migrando ao mesmo tempo.
 * - A linha `-- balcao:sem-transacao` no topo permite CREATE INDEX CONCURRENTLY.
 */

export interface Migracao {
  versao: string
  nome: string
  arquivo: string
  sql: string
  checksum: string
  semTransacao: boolean
}

export type EstadoMigracao = 'aplicada' | 'pendente' | 'alterada' | 'ausente'

export interface StatusMigracao {
  versao: string
  nome: string
  estado: EstadoMigracao
  aplicadaEm: Date | null
}

export class ErroMigracao extends Error {
  override name = 'ErroMigracao'
}

const PADRAO_ARQUIVO = /^(\d{4})_([a-z0-9_]+)\.sql$/
const TRAVA = 7_310_002_026 // número arbitrário, fixo, só para o advisory lock

export function checksum(sql: string): string {
  // Normaliza fim de linha para o checksum não mudar entre Windows e Linux.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex')
}

export function parseMigracao(arquivo: string, sql: string): Migracao {
  const m = PADRAO_ARQUIVO.exec(arquivo)
  if (!m) throw new ErroMigracao(`Nome de migração inválido: ${arquivo} (esperado NNNN_nome.sql)`)
  return {
    versao: m[1]!,
    nome: m[2]!,
    arquivo,
    sql,
    checksum: checksum(sql),
    semTransacao: /^--\s*balcao:sem-transacao\b/m.test(sql.split('\n', 3).join('\n')),
  }
}

export async function carregarMigracoes(dir: string): Promise<Migracao[]> {
  const arquivos = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  const migracoes: Migracao[] = []
  const vistas = new Set<string>()
  for (const arquivo of arquivos) {
    const mig = parseMigracao(arquivo, await readFile(path.join(dir, arquivo), 'utf8'))
    if (vistas.has(mig.versao)) throw new ErroMigracao(`Versão duplicada: ${mig.versao}`)
    vistas.add(mig.versao)
    migracoes.push(mig)
  }
  return migracoes
}

async function garantirTabela(client: pg.ClientBase): Promise<void> {
  await client.query(`
    create table if not exists schema_migrations (
      versao      text primary key,
      nome        text not null,
      checksum    text not null,
      aplicada_em timestamptz not null default now(),
      duracao_ms  integer not null
    )`)
}

interface LinhaAplicada {
  versao: string
  nome: string
  checksum: string
  aplicada_em: Date
}

export function compararMigracoes(locais: Migracao[], aplicadas: LinhaAplicada[]): StatusMigracao[] {
  const porVersao = new Map(aplicadas.map((a) => [a.versao, a]))
  const status: StatusMigracao[] = locais.map((m) => {
    const a = porVersao.get(m.versao)
    if (!a) return { versao: m.versao, nome: m.nome, estado: 'pendente', aplicadaEm: null }
    return {
      versao: m.versao,
      nome: m.nome,
      estado: a.checksum === m.checksum ? 'aplicada' : 'alterada',
      aplicadaEm: a.aplicada_em,
    }
  })
  const locaisVersoes = new Set(locais.map((m) => m.versao))
  for (const a of aplicadas) {
    if (!locaisVersoes.has(a.versao)) {
      status.push({ versao: a.versao, nome: a.nome, estado: 'ausente', aplicadaEm: a.aplicada_em })
    }
  }
  return status.sort((x, y) => x.versao.localeCompare(y.versao))
}

export async function statusMigracoes(client: pg.ClientBase, locais: Migracao[]): Promise<StatusMigracao[]> {
  await garantirTabela(client)
  const { rows } = await client.query<LinhaAplicada>(
    'select versao, nome, checksum, aplicada_em from schema_migrations order by versao',
  )
  return compararMigracoes(locais, rows)
}

export async function migrar(
  client: pg.ClientBase,
  locais: Migracao[],
  log: (msg: string) => void = () => {},
): Promise<Migracao[]> {
  await client.query('select pg_advisory_lock($1)', [TRAVA])
  try {
    const status = await statusMigracoes(client, locais)
    const problemas = status.filter((s) => s.estado === 'alterada' || s.estado === 'ausente')
    if (problemas.length > 0) {
      const lista = problemas.map((p) => `${p.versao}_${p.nome} (${p.estado})`).join(', ')
      throw new ErroMigracao(
        `Migrações aplicadas não batem com os arquivos: ${lista}. Não edite migração aplicada; crie uma nova.`,
      )
    }
    const pendentes = new Set(status.filter((s) => s.estado === 'pendente').map((s) => s.versao))
    const aplicadas: Migracao[] = []
    for (const mig of locais) {
      if (!pendentes.has(mig.versao)) continue
      const inicio = performance.now()
      if (!mig.semTransacao) await client.query('begin')
      try {
        await client.query(mig.sql)
        await client.query(
          'insert into schema_migrations (versao, nome, checksum, duracao_ms) values ($1, $2, $3, $4)',
          [mig.versao, mig.nome, mig.checksum, Math.round(performance.now() - inicio)],
        )
        if (!mig.semTransacao) await client.query('commit')
      } catch (err) {
        if (!mig.semTransacao) await client.query('rollback')
        const msg = err instanceof Error ? err.message : String(err)
        throw new ErroMigracao(`Falha na migração ${mig.arquivo}: ${msg}`)
      }
      log(`aplicada ${mig.arquivo} (${Math.round(performance.now() - inicio)} ms)`)
      aplicadas.push(mig)
    }
    return aplicadas
  } finally {
    await client.query('select pg_advisory_unlock($1)', [TRAVA])
  }
}
