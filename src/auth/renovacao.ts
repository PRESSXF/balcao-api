import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Db } from '../db/pool.js'

/**
 * Tokens de renovação rotativos.
 *
 * Formato entregue ao cliente: `<tenant_id>.<id>.<segredo>`. O tenant vem
 * junto porque a tabela está sob RLS: para achar o token, a transação já
 * precisa saber de qual empresa ele é. No banco fica só o SHA-256 do segredo.
 *
 * Cada uso marca o token como usado e emite o próximo da mesma família. Se um
 * token já usado aparecer de novo, alguém copiou o token: a família inteira é
 * revogada e o usuário precisa entrar de novo.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface TokenRenovacaoLido {
  tenantId: string
  id: string
  segredo: string
}

export function lerTokenRenovacao(token: string): TokenRenovacaoLido | null {
  const partes = token.split('.')
  if (partes.length !== 3) return null
  const [tenantId, id, segredo] = partes as [string, string, string]
  if (!UUID.test(tenantId) || !UUID.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(segredo)) return null
  return { tenantId, id, segredo }
}

export function hashSegredo(segredo: string): Buffer {
  return createHash('sha256').update(segredo).digest()
}

export async function emitirRenovacao(
  db: Db,
  dados: { tenantId: string; usuarioId: string; familia?: string; ttlSeg: number },
): Promise<{ token: string; expiraEm: Date }> {
  const id = randomUUID()
  const segredo = randomBytes(32).toString('base64url')
  const linha = await db.one<{ expira_em: Date }>(
    `insert into refresh_tokens (id, tenant_id, usuario_id, familia, token_hash, expira_em)
     values ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))
     returning expira_em`,
    [id, dados.tenantId, dados.usuarioId, dados.familia ?? randomUUID(), hashSegredo(segredo), dados.ttlSeg],
  )
  return { token: `${dados.tenantId}.${id}.${segredo}`, expiraEm: linha.expira_em }
}

export type ResultadoRotacao =
  | { ok: true; usuarioId: string; familia: string }
  | { ok: false; motivo: 'inexistente' | 'expirado' | 'reutilizado' | 'revogado' }

/** Marca o token como usado. Deve rodar dentro de withTenant(lido.tenantId). */
export async function consumirRenovacao(db: Db, lido: TokenRenovacaoLido): Promise<ResultadoRotacao> {
  const linha = await db.maybeOne<{
    usuario_id: string
    familia: string
    token_hash: Buffer
    expirado: boolean
    usado_em: Date | null
    revogado_em: Date | null
    ativo: boolean
  }>(
    `select r.usuario_id, r.familia, r.token_hash, r.expira_em <= now() as expirado,
            r.usado_em, r.revogado_em, u.ativo
       from refresh_tokens r
       join usuarios u on u.tenant_id = r.tenant_id and u.id = r.usuario_id
      where r.id = $1
      for update of r`,
    [lido.id],
  )
  if (!linha) return { ok: false, motivo: 'inexistente' }
  const recebido = hashSegredo(lido.segredo)
  if (!timingSafeEqual(recebido, linha.token_hash)) return { ok: false, motivo: 'inexistente' }

  if (linha.usado_em || linha.revogado_em) {
    await revogarFamilia(db, linha.familia)
    return { ok: false, motivo: linha.revogado_em && !linha.usado_em ? 'revogado' : 'reutilizado' }
  }
  if (linha.expirado || !linha.ativo) return { ok: false, motivo: 'expirado' }

  await db.execute('update refresh_tokens set usado_em = now() where id = $1', [lido.id])
  return { ok: true, usuarioId: linha.usuario_id, familia: linha.familia }
}

export async function revogarFamilia(db: Db, familia: string): Promise<number> {
  return db.execute(
    'update refresh_tokens set revogado_em = now() where familia = $1 and revogado_em is null',
    [familia],
  )
}
