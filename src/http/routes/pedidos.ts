import { createHash } from 'node:crypto'
import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { Db } from '../../db/pool.js'
import { enfileirar } from '../../jobs/fila.js'
import { decodificarCursor, paginar } from '../../lib/cursor.js'
import { ErroApi, naoEncontrado } from '../erros.js'
import { Centavos, Enum, Erros, Pagina, Paginacao, SEGURANCA, Uuid } from '../esquemas.js'

const Data = () => Type.Unsafe<Date>({ type: 'string', format: 'date-time' })

const Item = Type.Object({
  descricao: Type.String({ minLength: 1, maxLength: 200 }),
  quantidade: Type.Integer({ minimum: 1, maximum: 999 }),
  preco_unitario_centavos: Centavos('Preço unitário em centavos'),
})

const Pedido = Type.Object({
  id: Uuid(),
  cliente_id: Type.Union([Uuid(), Type.Null()]),
  status: Enum(['aberto', 'pago', 'cancelado'] as const),
  total_centavos: Type.Integer({ description: 'Soma dos itens, calculada por gatilho no banco' }),
  criado_em: Data(),
  itens: Type.Array(Item),
})
type LinhaPedido = Type.Static<typeof Pedido>

const SELECT_PEDIDO = `
  select p.id, p.cliente_id, p.status, p.total_centavos, p.criado_em,
         coalesce((select json_agg(json_build_object('descricao', i.descricao, 'quantidade', i.quantidade,
                                                     'preco_unitario_centavos', i.preco_unitario_centavos) order by i.descricao)
                     from itens_pedido i where i.tenant_id = p.tenant_id and i.pedido_id = p.id), '[]') as itens
    from pedidos p`

async function buscarPedido(db: Db, id: string): Promise<LinhaPedido> {
  const p = await db.maybeOne<LinhaPedido>(`${SELECT_PEDIDO} where p.id = $1`, [id])
  if (!p) throw naoEncontrado('Pedido')
  return p
}

/** Hash canônico do corpo: mesma chave com corpo diferente é erro, não repetição. */
export function hashCorpo(corpo: unknown): string {
  const ordenar = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(ordenar) :
    v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, ordenar(x)])) :
    v
  return createHash('sha256').update(JSON.stringify(ordenar(corpo))).digest('hex')
}

export const rotasPedidos: FastifyPluginAsyncTypebox = async (app) => {
  const qualquer = app.exigir()

  app.post(
    '/pedidos',
    {
      preHandler: qualquer,
      schema: {
        tags: ['pedidos'],
        summary: 'Criar pedido (idempotente)',
        description:
          'Exige o cabeçalho `Idempotency-Key`. Repetir a requisição com a mesma chave devolve o mesmo pedido (200, ' +
          'cabeçalho `Idempotent-Replayed: true`), mesmo com as duas chegando ao mesmo tempo. A mesma chave com um ' +
          'corpo diferente é recusada com 422.',
        security: SEGURANCA,
        headers: Type.Object({
          'idempotency-key': Type.String({ minLength: 8, maxLength: 120, pattern: '^[A-Za-z0-9._:-]+$', description: 'Ex.: um UUID gerado pelo cliente' }),
        }),
        body: Type.Object(
          { cliente_id: Type.Optional(Uuid()), itens: Type.Array(Item, { minItems: 1, maxItems: 50 }) },
          { additionalProperties: false },
        ),
        response: { 200: Pedido, 201: Pedido, ...Erros(400, 401, 422) },
      },
    },
    async (req, reply) => {
      const chave = req.headers['idempotency-key']
      const hash = hashCorpo(req.body)
      const r = await req.db(async (db) => {
        // Se outra requisição com a mesma chave estiver no meio da transação, este
        // INSERT espera por ela no índice único e depois cai no DO NOTHING.
        const novo = await db.maybeOne<{ id: string }>(
          `insert into pedidos (tenant_id, cliente_id, chave_idempotencia, hash_requisicao, criado_por)
           values (app_tenant(), $1, $2, $3, app_usuario())
           on conflict (tenant_id, chave_idempotencia) do nothing
           returning id`,
          [req.body.cliente_id ?? null, chave, hash],
        )
        if (!novo) {
          const existente = await db.one<{ id: string; hash_requisicao: string }>(
            'select id, hash_requisicao from pedidos where chave_idempotencia = $1',
            [chave],
          )
          if (existente.hash_requisicao !== hash) {
            throw new ErroApi(422, 'chave_reutilizada', 'Esta Idempotency-Key já foi usada com outro corpo. Gere uma chave nova para um pedido novo.')
          }
          return { pedido: await buscarPedido(db, existente.id), repetido: true }
        }
        await db.execute(
          `insert into itens_pedido (tenant_id, pedido_id, descricao, quantidade, preco_unitario_centavos)
           select app_tenant(), $1, x.descricao, x.quantidade, x.preco_unitario_centavos
             from jsonb_to_recordset($2::jsonb) as x(descricao text, quantidade int, preco_unitario_centavos int)`,
          [novo.id, JSON.stringify(req.body.itens)],
        )
        const pedido = await buscarPedido(db, novo.id)
        await enfileirar(db, {
          tipo: 'entrega_webhook',
          payload: { evento: 'pedido.criado', ocorrido_em: new Date().toISOString(), dados: { pedido_id: pedido.id, total_centavos: pedido.total_centavos } },
          chave: `pedido.criado:${pedido.id}`,
        })
        return { pedido, repetido: false }
      })
      if (r.repetido) return reply.status(200).header('idempotent-replayed', 'true').send(r.pedido)
      return reply.status(201).send(r.pedido)
    },
  )

  app.get(
    '/pedidos',
    {
      preHandler: qualquer,
      schema: {
        tags: ['pedidos'],
        summary: 'Pedidos mais recentes primeiro, paginados por cursor',
        security: SEGURANCA,
        querystring: Paginacao,
        response: { 200: Pagina(Pedido), ...Erros(400, 401) },
      },
    },
    async (req) => {
      const limite = req.query.limite ?? 20
      const cursor = decodificarCursor(req.query.cursor, ['string', 'string'])
      const linhas = await req.db((db) =>
        db.query<LinhaPedido>(
          `${SELECT_PEDIDO}
            where ($1::timestamptz is null or (p.criado_em, p.id) < ($1::timestamptz, $2::uuid))
            order by p.criado_em desc, p.id desc
            limit $3`,
          [cursor?.[0] ?? null, cursor?.[1] ?? null, limite + 1],
        ),
      )
      return paginar(linhas, limite, (p) => [new Date(p.criado_em).toISOString(), p.id])
    },
  )

  app.get(
    '/pedidos/:id',
    {
      preHandler: qualquer,
      schema: { tags: ['pedidos'], summary: 'Um pedido', security: SEGURANCA, params: Type.Object({ id: Uuid() }), response: { 200: Pedido, ...Erros(400, 401, 404) } },
    },
    async (req) => req.db((db) => buscarPedido(db, req.params.id)),
  )
}
