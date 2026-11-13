import { Type, type TSchema } from '@fastify/type-provider-typebox'

/** Esquemas compartilhados pelas rotas (validação + OpenAPI). */

export const Uuid = (descricao?: string) => Type.String({ format: 'uuid', ...(descricao ? { description: descricao } : {}) })

/** Enum como `{ type: string, enum: [...] }`: gera OpenAPI limpo e erro de validação legível. */
export function Enum<T extends string>(valores: readonly T[], extra: Record<string, unknown> = {}) {
  return Type.Unsafe<T>({ type: 'string', enum: [...valores], ...extra })
}

export const Centavos = (descricao = 'Valor em centavos de real') =>
  Type.Integer({ minimum: 0, maximum: 10_000_000, description: descricao })

export const ErroResposta = Type.Object(
  {
    erro: Type.Object({
      codigo: Type.String({ description: 'Código estável para tratamento no cliente' }),
      mensagem: Type.String({ description: 'Mensagem em português, pronta para exibir' }),
      detalhes: Type.Optional(
        Type.Array(
          Type.Object({
            campo: Type.Optional(Type.String()),
            mensagem: Type.String(),
            restricao: Type.Optional(Type.String()),
          }),
        ),
      ),
    }),
    requisicao: Type.String({ description: 'Id da requisição, igual ao dos logs' }),
  },
  { $id: 'Erro', description: 'Formato único de erro da API' },
)

export const ref = (id: string) => Type.Unsafe<unknown>({ $ref: `${id}#` })

export const Erros = (...codigos: number[]) =>
  Object.fromEntries(codigos.map((c) => [c, ref('Erro')])) as Record<number, TSchema>

export const Paginacao = Type.Object({
  limite: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  cursor: Type.Optional(Type.String({ maxLength: 500, description: 'Valor de "proximo" da página anterior' })),
})

export const Pagina = <T extends TSchema>(item: T) =>
  Type.Object({
    itens: Type.Array(item),
    proximo: Type.Union([Type.String(), Type.Null()], { description: 'Cursor da próxima página, ou null no fim' }),
  })

export const SEGURANCA = [{ bearer: [] }]
