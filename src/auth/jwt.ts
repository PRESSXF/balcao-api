import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * JWT HS256 implementado com node:crypto. Pequeno de propósito: só um
 * algoritmo, cabeçalho conferido byte a byte (nada de "alg": "none") e
 * expiração curta. O token de acesso não é guardado no banco; quem garante a
 * revogação é o token de renovação, que é.
 */

export type Papel = 'dono' | 'atendente'

export interface ClaimsAcesso {
  sub: string // id do usuário
  tid: string // id da empresa
  papel: Papel
  iat: number
  exp: number
  iss: 'balcao'
}

export class ErroToken extends Error {
  constructor(public codigo: 'token_invalido' | 'token_expirado') {
    super(codigo === 'token_expirado' ? 'Token de acesso expirado.' : 'Token de acesso inválido.')
  }
}

const CABECALHO = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')

function assinar(dados: string, segredo: string): Buffer {
  return createHmac('sha256', segredo).update(dados).digest()
}

export function emitirAcesso(
  dados: { usuarioId: string; tenantId: string; papel: Papel },
  segredo: string,
  ttlSeg: number,
  agora = Date.now(),
): { token: string; expiraEm: Date } {
  const iat = Math.floor(agora / 1000)
  const claims: ClaimsAcesso = {
    sub: dados.usuarioId,
    tid: dados.tenantId,
    papel: dados.papel,
    iat,
    exp: iat + ttlSeg,
    iss: 'balcao',
  }
  const corpo = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const assinatura = assinar(`${CABECALHO}.${corpo}`, segredo).toString('base64url')
  return { token: `${CABECALHO}.${corpo}.${assinatura}`, expiraEm: new Date(claims.exp * 1000) }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function verificarAcesso(token: string, segredo: string, agora = Date.now()): ClaimsAcesso {
  const partes = token.split('.')
  if (partes.length !== 3) throw new ErroToken('token_invalido')
  const [cabecalho, corpo, assinatura] = partes as [string, string, string]
  if (cabecalho !== CABECALHO) throw new ErroToken('token_invalido')

  const esperada = assinar(`${cabecalho}.${corpo}`, segredo)
  const recebida = Buffer.from(assinatura, 'base64url')
  if (recebida.length !== esperada.length || !timingSafeEqual(recebida, esperada)) {
    throw new ErroToken('token_invalido')
  }

  let claims: Partial<ClaimsAcesso>
  try {
    claims = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8')) as Partial<ClaimsAcesso>
  } catch {
    throw new ErroToken('token_invalido')
  }
  if (
    claims.iss !== 'balcao' ||
    typeof claims.sub !== 'string' || !UUID.test(claims.sub) ||
    typeof claims.tid !== 'string' || !UUID.test(claims.tid) ||
    (claims.papel !== 'dono' && claims.papel !== 'atendente') ||
    typeof claims.exp !== 'number' || typeof claims.iat !== 'number'
  ) {
    throw new ErroToken('token_invalido')
  }
  if (Math.floor(agora / 1000) >= claims.exp) throw new ErroToken('token_expirado')
  return claims as ClaimsAcesso
}
