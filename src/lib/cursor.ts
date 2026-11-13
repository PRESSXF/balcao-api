import { ErroApi } from '../http/erros.js'

/**
 * Paginação por cursor (keyset). O cursor é a chave de ordenação do último
 * item da página, em JSON e base64url. Diferente de OFFSET, o custo não cresce
 * com o número da página e nada se repete ou some quando entram registros
 * novos no meio da navegação.
 */

export function codificarCursor(chave: (string | number)[]): string {
  return Buffer.from(JSON.stringify(chave)).toString('base64url')
}

export function decodificarCursor(cursor: string | undefined, tipos: ('string' | 'number')[]): (string | number)[] | null {
  if (cursor === undefined || cursor === '') return null
  let valor: unknown
  try {
    valor = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw cursorInvalido()
  }
  if (!Array.isArray(valor) || valor.length !== tipos.length) throw cursorInvalido()
  valor.forEach((v, i) => {
    if (typeof v !== tipos[i]) throw cursorInvalido()
  })
  return valor as (string | number)[]
}

function cursorInvalido(): ErroApi {
  return new ErroApi(400, 'cursor_invalido', 'O cursor de paginação é inválido. Use o valor de "proximo" da página anterior.')
}

/** Recebe limite + 1 linhas e devolve a página e o cursor da próxima, se houver. */
export function paginar<T>(linhas: T[], limite: number, chave: (item: T) => (string | number)[]) {
  const temMais = linhas.length > limite
  const itens = temMais ? linhas.slice(0, limite) : linhas
  const ultimo = itens[itens.length - 1]
  return { itens, proximo: temMais && ultimo ? codificarCursor(chave(ultimo)) : null }
}
