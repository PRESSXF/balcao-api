import { describe, expect, it } from 'vitest'
import { emitirAcesso, ErroToken, verificarAcesso } from '../../src/auth/jwt.js'
import { hashSegredo, lerTokenRenovacao } from '../../src/auth/renovacao.js'
import { gerarHash, verificarSenha } from '../../src/auth/senha.js'

const SEGREDO = 'segredo-de-teste-com-pelo-menos-32-caracteres'
const USUARIO = '6f1c1c1e-1b1a-4c4c-8d8d-1a2b3c4d5e6f'
const EMPRESA = '0b0a1c11-0000-4000-8000-000000000001'

describe('senha (scrypt)', () => {
  it('gera hash com parâmetros e sal, e confere só a senha certa', async () => {
    const h = await gerarHash('balcao123')
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/)
    expect(await verificarSenha('balcao123', h)).toBe(true)
    expect(await verificarSenha('balcao124', h)).toBe(false)
    expect(await verificarSenha('', h)).toBe(false)
  })

  it('mesma senha, hashes diferentes (sal aleatório)', async () => {
    expect(await gerarHash('x')).not.toBe(await gerarHash('x'))
  })

  it('normaliza Unicode: "ç" composto e decomposto são a mesma senha', async () => {
    const h = await gerarHash('maçã')
    expect(await verificarSenha('maçã', h)).toBe(true)
  })

  it('hash malformado nunca confere', async () => {
    for (const ruim of ['', 'bcrypt$x', 'scrypt$1$2$3', 'scrypt$16384$8$1$AAAA$']) {
      expect(await verificarSenha('x', ruim)).toBe(false)
    }
  })
})

describe('JWT de acesso (HS256 próprio)', () => {
  const agora = Date.UTC(2026, 10, 16, 12, 0, 0)
  const emitir = (ttl = 900) => emitirAcesso({ usuarioId: USUARIO, tenantId: EMPRESA, papel: 'dono' }, SEGREDO, ttl, agora)

  it('ida e volta com as claims', () => {
    const { token, expiraEm } = emitir()
    expect(expiraEm.toISOString()).toBe('2026-11-16T12:15:00.000Z')
    expect(verificarAcesso(token, SEGREDO, agora + 1000)).toMatchObject({ sub: USUARIO, tid: EMPRESA, papel: 'dono', iss: 'balcao' })
  })

  it('expira no segundo exato', () => {
    const { token } = emitir(60)
    expect(() => verificarAcesso(token, SEGREDO, agora + 59_999)).not.toThrow()
    expect(() => verificarAcesso(token, SEGREDO, agora + 60_000)).toThrow(new ErroToken('token_expirado'))
  })

  it('recusa assinatura com outro segredo, claims trocadas e alg "none"', () => {
    const { token } = emitir()
    const [h, c, s] = token.split('.') as [string, string, string]
    expect(() => verificarAcesso(token, `${SEGREDO}-outro`, agora)).toThrow(ErroToken)

    const claims = JSON.parse(Buffer.from(c, 'base64url').toString())
    const promovido = Buffer.from(JSON.stringify({ ...claims, papel: 'dono', tid: '0b0a1c11-0000-4000-8000-000000000002' })).toString('base64url')
    expect(() => verificarAcesso(`${h}.${promovido}.${s}`, SEGREDO, agora)).toThrow(ErroToken)

    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    expect(() => verificarAcesso(`${none}.${c}.`, SEGREDO, agora)).toThrow(ErroToken)
    expect(() => verificarAcesso(`${none}.${c}.${s}`, SEGREDO, agora)).toThrow(ErroToken)
  })

  it('recusa formatos quebrados', () => {
    for (const t of ['', 'a.b', 'a.b.c.d', '...']) expect(() => verificarAcesso(t, SEGREDO, agora)).toThrow(ErroToken)
  })
})

describe('token de renovação', () => {
  it('lê tenant, id e segredo e recusa o resto', () => {
    const segredo = 'A'.repeat(43)
    expect(lerTokenRenovacao(`${EMPRESA}.${USUARIO}.${segredo}`)).toEqual({ tenantId: EMPRESA, id: USUARIO, segredo })
    expect(lerTokenRenovacao(`${EMPRESA}.${USUARIO}`)).toBeNull()
    expect(lerTokenRenovacao(`x.${USUARIO}.${segredo}`)).toBeNull()
    expect(lerTokenRenovacao(`${EMPRESA}.${USUARIO}.curto`)).toBeNull()
    expect(lerTokenRenovacao(`${EMPRESA}.${USUARIO}.${segredo}'; drop table x;--`)).toBeNull()
  })

  it('hash do segredo tem 32 bytes', () => {
    expect(hashSegredo('abc')).toHaveLength(32)
  })
})
