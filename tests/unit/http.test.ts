import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { traduzirErroBanco, traduzirErroValidacao } from '../../src/http/erros.js'
import { hashCorpo } from '../../src/http/routes/pedidos.js'
import { codificarCursor, decodificarCursor, paginar } from '../../src/lib/cursor.js'

function erroPg(campos: Partial<pg.DatabaseError>): pg.DatabaseError {
  const e = new pg.DatabaseError('mensagem do banco', 0, 'error')
  return Object.assign(e, campos)
}

describe('tradução de erros de validação', () => {
  it.each([
    [{ keyword: 'required', instancePath: '', params: { missingProperty: 'nome' } }, 'body', { campo: 'nome', mensagem: 'é obrigatório' }],
    [{ keyword: 'required', instancePath: '/itens/0', params: { missingProperty: 'quantidade' } }, 'body', { campo: 'itens.0.quantidade', mensagem: 'é obrigatório' }],
    [{ keyword: 'type', instancePath: '/quantidade', params: { type: 'integer' } }, 'body', { campo: 'quantidade', mensagem: 'deve ser número inteiro' }],
    [{ keyword: 'minimum', instancePath: '/limite', params: { limit: 1 } }, 'querystring', { campo: 'query.limite', mensagem: 'deve ser no mínimo 1' }],
    [{ keyword: 'format', instancePath: '/id', params: { format: 'uuid' } }, 'params', { campo: 'parametro.id', mensagem: 'deve ser um identificador UUID' }],
    [{ keyword: 'enum', instancePath: '/status', params: { allowedValues: ['agendado', 'cancelado'] } }, 'body', { campo: 'status', mensagem: 'deve ser um destes valores: agendado, cancelado' }],
    [{ keyword: 'additionalProperties', instancePath: '', params: { additionalProperty: 'tenant_id' } }, 'body', { campo: 'tenant_id', mensagem: 'não é permitido' }],
    [{ keyword: 'minItems', instancePath: '/itens', params: { limit: 1 } }, 'body', { campo: 'itens', mensagem: 'deve ter pelo menos 1 item(ns)' }],
    [{ keyword: 'qualquer', instancePath: '', params: {} }, 'body', { campo: '(corpo)', mensagem: 'valor inválido' }],
  ])('%o', (erro, contexto, esperado) => {
    expect(traduzirErroValidacao(erro, contexto)).toEqual(esperado)
  })
})

describe('tradução de erros do PostgreSQL', () => {
  it('restrição de exclusão da agenda vira 409 conflito_horario', () => {
    const e = traduzirErroBanco(erroPg({ code: '23P01', constraint: 'agendamentos_sem_sobreposicao' }))
    expect(e).toMatchObject({ statusCode: 409, codigo: 'conflito_horario', detalhes: [{ restricao: 'agendamentos_sem_sobreposicao' }] })
  })

  it('códigos genéricos', () => {
    expect(traduzirErroBanco(erroPg({ code: '23503' }))).toMatchObject({ statusCode: 422, codigo: 'referencia_invalida' })
    expect(traduzirErroBanco(erroPg({ code: '23514', constraint: 'x_check' }))).toMatchObject({ statusCode: 422, codigo: 'regra_violada' })
    expect(traduzirErroBanco(erroPg({ code: '23505', constraint: 'outra_key' }))).toMatchObject({ statusCode: 409, codigo: 'registro_duplicado' })
    expect(traduzirErroBanco(erroPg({ code: '42501' }))).toMatchObject({ statusCode: 403 })
  })

  it('exceção de gatilho usa a dica como código e a mensagem do banco', () => {
    const e = traduzirErroBanco(erroPg({ code: 'P0001', hint: 'transicao_invalida' }))
    expect(e).toMatchObject({ statusCode: 422, codigo: 'transicao_invalida', message: 'mensagem do banco' })
  })

  it('erro que não é do banco ou desconhecido devolve null (vira 500)', () => {
    expect(traduzirErroBanco(new Error('x'))).toBeNull()
    expect(traduzirErroBanco(erroPg({ code: '57P01' }))).toBeNull()
  })
})

describe('cursor', () => {
  it('ida e volta', () => {
    const c = codificarCursor(['Ana Souza', 'b3c1e2a4-0000-4000-8000-000000000000'])
    expect(decodificarCursor(c, ['string', 'string'])).toEqual(['Ana Souza', 'b3c1e2a4-0000-4000-8000-000000000000'])
    expect(decodificarCursor(undefined, ['string'])).toBeNull()
  })

  it('recusa lixo, tamanho errado e tipo errado', () => {
    expect(() => decodificarCursor('%%%', ['string'])).toThrow(/cursor/)
    expect(() => decodificarCursor(codificarCursor(['a']), ['string', 'string'])).toThrow(/cursor/)
    expect(() => decodificarCursor(codificarCursor(['a']), ['number'])).toThrow(/cursor/)
  })

  it('paginar usa limite + 1 para saber se há próxima página', () => {
    const linhas = [{ id: 1 }, { id: 2 }, { id: 3 }]
    expect(paginar(linhas, 2, (l) => [l.id])).toEqual({ itens: [{ id: 1 }, { id: 2 }], proximo: codificarCursor([2]) })
    expect(paginar(linhas, 3, (l) => [l.id])).toEqual({ itens: linhas, proximo: null })
    expect(paginar([], 3, () => [])).toEqual({ itens: [], proximo: null })
  })
})

describe('hash do corpo para idempotência', () => {
  it('ignora a ordem das chaves, mas não a dos itens', () => {
    const a = { itens: [{ descricao: 'x', quantidade: 1 }], cliente_id: 'c' }
    const b = { cliente_id: 'c', itens: [{ quantidade: 1, descricao: 'x' }] }
    expect(hashCorpo(a)).toBe(hashCorpo(b))
    expect(hashCorpo({ itens: [1, 2] })).not.toBe(hashCorpo({ itens: [2, 1] }))
  })
})
