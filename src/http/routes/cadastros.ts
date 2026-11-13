import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { decodificarCursor, paginar } from '../../lib/cursor.js'
import { naoEncontrado } from '../erros.js'
import { Centavos, Enum, Erros, Pagina, Paginacao, SEGURANCA, Uuid } from '../esquemas.js'

const Data = () => Type.Unsafe<Date>({ type: 'string', format: 'date-time' })

const Profissional = Type.Object({ id: Uuid(), nome: Type.String(), especialidade: Type.String(), ativo: Type.Boolean() })
const Servico = Type.Object({ id: Uuid(), nome: Type.String(), duracao_min: Type.Integer(), preco_centavos: Type.Integer(), ativo: Type.Boolean() })
const Cliente = Type.Object({
  id: Uuid(),
  nome: Type.String(),
  telefone: Type.String(),
  email: Type.Union([Type.String(), Type.Null()]),
  criado_em: Data(),
})
const Usuario = Type.Object({ id: Uuid(), nome: Type.String(), email: Type.String(), papel: Enum(['dono', 'atendente'] as const), ativo: Type.Boolean() })

type LinhaCliente = { id: string; nome: string; telefone: string; email: string | null; criado_em: Date }

export const rotasCadastros: FastifyPluginAsyncTypebox = async (app) => {
  const qualquer = app.exigir()
  const dono = app.exigir('dono')

  app.get(
    '/profissionais',
    { preHandler: qualquer, schema: { tags: ['cadastros'], summary: 'Profissionais (ou recursos com agenda)', security: SEGURANCA, response: { 200: Type.Array(Profissional), ...Erros(401) } } },
    async (req) => req.db((db) => db.query<Type.Static<typeof Profissional>>('select id, nome, especialidade, ativo from profissionais order by nome')),
  )

  app.post(
    '/profissionais',
    {
      preHandler: dono,
      schema: {
        tags: ['cadastros'],
        summary: 'Cadastrar profissional (dono)',
        security: SEGURANCA,
        body: Type.Object(
          { nome: Type.String({ minLength: 2, maxLength: 120 }), especialidade: Type.Optional(Type.String({ maxLength: 120 })) },
          { additionalProperties: false },
        ),
        response: { 201: Profissional, ...Erros(400, 401, 403) },
      },
    },
    async (req, reply) => {
      const p = await req.db((db) =>
        db.one<Type.Static<typeof Profissional>>(
          `insert into profissionais (tenant_id, nome, especialidade) values (app_tenant(), $1, $2)
           returning id, nome, especialidade, ativo`,
          [req.body.nome, req.body.especialidade ?? ''],
        ),
      )
      return reply.status(201).send(p)
    },
  )

  app.get(
    '/servicos',
    { preHandler: qualquer, schema: { tags: ['cadastros'], summary: 'Serviços', security: SEGURANCA, response: { 200: Type.Array(Servico), ...Erros(401) } } },
    async (req) => req.db((db) => db.query<Type.Static<typeof Servico>>('select id, nome, duracao_min, preco_centavos, ativo from servicos order by nome')),
  )

  app.post(
    '/servicos',
    {
      preHandler: dono,
      schema: {
        tags: ['cadastros'],
        summary: 'Cadastrar serviço (dono)',
        security: SEGURANCA,
        body: Type.Object(
          {
            nome: Type.String({ minLength: 2, maxLength: 120 }),
            duracao_min: Type.Integer({ minimum: 5, maximum: 480 }),
            preco_centavos: Centavos(),
          },
          { additionalProperties: false },
        ),
        response: { 201: Servico, ...Erros(400, 401, 403, 409) },
      },
    },
    async (req, reply) => {
      const s = await req.db((db) =>
        db.one<Type.Static<typeof Servico>>(
          `insert into servicos (tenant_id, nome, duracao_min, preco_centavos) values (app_tenant(), $1, $2, $3)
           returning id, nome, duracao_min, preco_centavos, ativo`,
          [req.body.nome, req.body.duracao_min, req.body.preco_centavos],
        ),
      )
      return reply.status(201).send(s)
    },
  )

  app.get(
    '/clientes',
    {
      preHandler: qualquer,
      schema: {
        tags: ['cadastros'],
        summary: 'Clientes em ordem alfabética, paginados por cursor',
        security: SEGURANCA,
        querystring: Type.Object({ ...Paginacao.properties, busca: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: 'Início do nome' })) }),
        response: { 200: Pagina(Cliente), ...Erros(400, 401) },
      },
    },
    async (req) => {
      const limite = req.query.limite ?? 20
      const cursor = decodificarCursor(req.query.cursor, ['string', 'string'])
      const linhas = await req.db((db) =>
        db.query<LinhaCliente>(
          `select id, nome, telefone, email, criado_em from clientes
            where ($1::text is null or (nome, id) > ($1::text, $2::uuid))
              and ($3::text is null or nome ilike $3 || '%')
            order by nome, id
            limit $4`,
          [cursor?.[0] ?? null, cursor?.[1] ?? null, req.query.busca?.replace(/[%_\\]/g, '\\$&') ?? null, limite + 1],
        ),
      )
      return paginar(linhas, limite, (c) => [c.nome, c.id])
    },
  )

  app.get(
    '/clientes/:id',
    {
      preHandler: qualquer,
      schema: { tags: ['cadastros'], summary: 'Um cliente', security: SEGURANCA, params: Type.Object({ id: Uuid() }), response: { 200: Cliente, ...Erros(400, 401, 404) } },
    },
    async (req) => {
      const c = await req.db((db) => db.maybeOne<LinhaCliente>('select id, nome, telefone, email, criado_em from clientes where id = $1', [req.params.id]))
      if (!c) throw naoEncontrado('Cliente')
      return c
    },
  )

  app.post(
    '/clientes',
    {
      preHandler: qualquer,
      schema: {
        tags: ['cadastros'],
        summary: 'Cadastrar cliente',
        security: SEGURANCA,
        body: Type.Object(
          {
            nome: Type.String({ minLength: 2, maxLength: 120 }),
            telefone: Type.String({ pattern: '^\\+55[1-9][0-9]{9,10}$', description: 'Formato E.164 do Brasil, ex.: +5581998765432' }),
            email: Type.Optional(Type.String({ format: 'email', maxLength: 200 })),
          },
          { additionalProperties: false },
        ),
        response: { 201: Cliente, ...Erros(400, 401, 409) },
      },
    },
    async (req, reply) => {
      const c = await req.db((db) =>
        db.one<LinhaCliente>(
          `insert into clientes (tenant_id, nome, telefone, email) values (app_tenant(), $1, $2, $3)
           returning id, nome, telefone, email, criado_em`,
          [req.body.nome.trim(), req.body.telefone, req.body.email ?? null],
        ),
      )
      return reply.status(201).send(c)
    },
  )

  app.get(
    '/usuarios',
    { preHandler: dono, schema: { tags: ['cadastros'], summary: 'Usuários da empresa (dono)', security: SEGURANCA, response: { 200: Type.Array(Usuario), ...Erros(401, 403) } } },
    async (req) => req.db((db) => db.query<Type.Static<typeof Usuario>>('select id, nome, email, papel, ativo from usuarios order by papel desc, nome')),
  )
}
