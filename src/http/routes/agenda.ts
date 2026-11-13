import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { Db } from '../../db/pool.js'
import { enfileirar } from '../../jobs/fila.js'
import { decodificarCursor, paginar } from '../../lib/cursor.js'
import { ErroApi, naoEncontrado } from '../erros.js'
import { Enum, Erros, Pagina, Paginacao, SEGURANCA, Uuid } from '../esquemas.js'

const STATUS = ['agendado', 'confirmado', 'concluido', 'cancelado', 'faltou'] as const
const Data = () => Type.Unsafe<Date>({ type: 'string', format: 'date-time' })

const Agendamento = Type.Object({
  id: Uuid(),
  profissional_id: Uuid(),
  profissional: Type.String(),
  cliente_id: Uuid(),
  cliente: Type.String(),
  servico_id: Uuid(),
  servico: Type.String(),
  inicio: Data(),
  fim: Data(),
  status: Enum(STATUS),
  preco_centavos: Type.Integer({ description: 'Preço do serviço no momento do agendamento, em centavos' }),
  observacao: Type.String(),
})
type LinhaAgendamento = Type.Static<typeof Agendamento>

const SELECT_AGENDAMENTO = `
  select a.id, a.profissional_id, p.nome as profissional, a.cliente_id, c.nome as cliente,
         a.servico_id, s.nome as servico, a.inicio, upper(a.periodo) as fim,
         a.status, a.preco_centavos, a.observacao
    from agendamentos a
    join profissionais p on p.tenant_id = a.tenant_id and p.id = a.profissional_id
    join clientes c on c.tenant_id = a.tenant_id and c.id = a.cliente_id
    join servicos s on s.tenant_id = a.tenant_id and s.id = a.servico_id`

async function buscarAgendamento(db: Db, id: string): Promise<LinhaAgendamento> {
  const a = await db.maybeOne<LinhaAgendamento>(`${SELECT_AGENDAMENTO} where a.id = $1`, [id])
  if (!a) throw naoEncontrado('Agendamento')
  return a
}

/** Lembrete 24 h antes (ou já, se faltar menos que isso) e webhook do evento. */
async function enfileirarEventos(db: Db, a: LinhaAgendamento, evento: string): Promise<void> {
  if (a.status === 'agendado' || a.status === 'confirmado') {
    const vinteQuatroAntes = new Date(new Date(a.inicio).getTime() - 24 * 3600 * 1000)
    await enfileirar(db, {
      tipo: 'lembrete_agendamento',
      payload: { agendamento_id: a.id, inicio: new Date(a.inicio).toISOString() },
      executarEm: vinteQuatroAntes > new Date() ? vinteQuatroAntes : undefined,
      chave: `lembrete:${a.id}:${new Date(a.inicio).toISOString()}`,
    })
  }
  await enfileirar(db, {
    tipo: 'entrega_webhook',
    payload: {
      evento,
      ocorrido_em: new Date().toISOString(),
      dados: { agendamento_id: a.id, profissional_id: a.profissional_id, cliente_id: a.cliente_id, inicio: a.inicio, fim: a.fim, status: a.status },
    },
  })
}

export const rotasAgenda: FastifyPluginAsyncTypebox = async (app) => {
  const qualquer = app.exigir()

  app.get(
    '/agenda',
    {
      preHandler: qualquer,
      schema: {
        tags: ['agenda'],
        summary: 'Agenda de um dia no fuso da empresa',
        security: SEGURANCA,
        querystring: Type.Object({
          dia: Type.Optional(Type.String({ format: 'date', description: 'AAAA-MM-DD; padrão: hoje no fuso da empresa' })),
          profissional_id: Type.Optional(Uuid()),
        }),
        response: {
          200: Type.Object({
            dia: Type.String({ format: 'date' }),
            fuso: Type.String(),
            profissionais: Type.Array(Type.Object({ id: Uuid(), nome: Type.String(), especialidade: Type.String() })),
            agendamentos: Type.Array(Agendamento),
          }),
          ...Erros(400, 401),
        },
      },
    },
    async (req) =>
      req.db(async (db) => {
        const t = await db.one<{ dia: string; fuso: string }>(
          `select coalesce($1::date, (now() at time zone fuso)::date)::text as dia, fuso from tenants where id = app_tenant()`,
          [req.query.dia ?? null],
        )
        const profissionais = await db.query<{ id: string; nome: string; especialidade: string }>(
          `select id, nome, especialidade from profissionais
            where ativo and ($1::uuid is null or id = $1) order by nome`,
          [req.query.profissional_id ?? null],
        )
        const agendamentos = await db.query<LinhaAgendamento>(
          `${SELECT_AGENDAMENTO}
            where a.inicio >= ($1::date)::timestamp at time zone $2
              and a.inicio <  ($1::date + 1)::timestamp at time zone $2
              and ($3::uuid is null or a.profissional_id = $3)
            order by a.inicio, a.id`,
          [t.dia, t.fuso, req.query.profissional_id ?? null],
        )
        return { dia: t.dia, fuso: t.fuso, profissionais, agendamentos }
      }),
  )

  app.get(
    '/agendamentos',
    {
      preHandler: qualquer,
      schema: {
        tags: ['agenda'],
        summary: 'Agendamentos por período, paginados por cursor',
        security: SEGURANCA,
        querystring: Type.Object({
          ...Paginacao.properties,
          de: Type.Optional(Type.String({ format: 'date-time' })),
          ate: Type.Optional(Type.String({ format: 'date-time' })),
          profissional_id: Type.Optional(Uuid()),
          cliente_id: Type.Optional(Uuid()),
          status: Type.Optional(Enum(STATUS)),
        }),
        response: { 200: Pagina(Agendamento), ...Erros(400, 401) },
      },
    },
    async (req) => {
      const q = req.query
      const limite = q.limite ?? 20
      const cursor = decodificarCursor(q.cursor, ['string', 'string'])
      const linhas = await req.db((db) =>
        db.query<LinhaAgendamento>(
          `${SELECT_AGENDAMENTO}
            where ($1::timestamptz is null or (a.inicio, a.id) > ($1::timestamptz, $2::uuid))
              and ($3::timestamptz is null or a.inicio >= $3)
              and ($4::timestamptz is null or a.inicio < $4)
              and ($5::uuid is null or a.profissional_id = $5)
              and ($6::uuid is null or a.cliente_id = $6)
              and ($7::text is null or a.status = $7)
            order by a.inicio, a.id
            limit $8`,
          [cursor?.[0] ?? null, cursor?.[1] ?? null, q.de ?? null, q.ate ?? null, q.profissional_id ?? null, q.cliente_id ?? null, q.status ?? null, limite + 1],
        ),
      )
      return paginar(linhas, limite, (a) => [new Date(a.inicio).toISOString(), a.id])
    },
  )

  app.post(
    '/agendamentos',
    {
      preHandler: qualquer,
      schema: {
        tags: ['agenda'],
        summary: 'Criar agendamento',
        description:
          'O fim é calculado pela duração do serviço e o preço é copiado do serviço. Se o profissional já tiver um ' +
          'agendamento ativo no período, o PostgreSQL recusa pela restrição de exclusão `agendamentos_sem_sobreposicao` ' +
          'e a API responde 409 `conflito_horario`. Na mesma transação entram o lembrete e o webhook na fila.',
        security: SEGURANCA,
        body: Type.Object(
          {
            profissional_id: Uuid(),
            cliente_id: Uuid(),
            servico_id: Uuid(),
            inicio: Type.String({ format: 'date-time', description: 'Com fuso, ex.: 2026-11-16T14:30:00-03:00' }),
            observacao: Type.Optional(Type.String({ maxLength: 500 })),
          },
          { additionalProperties: false },
        ),
        response: { 201: Agendamento, ...Erros(400, 401, 409, 422) },
      },
    },
    async (req, reply) => {
      const b = req.body
      const criado = await req.db(async (db) => {
        const novo = await db.maybeOne<{ id: string }>(
          `insert into agendamentos (tenant_id, profissional_id, cliente_id, servico_id, periodo, preco_centavos, observacao, criado_por)
           select app_tenant(), $1, $2, s.id,
                  tstzrange($4::timestamptz, $4::timestamptz + make_interval(mins => s.duracao_min), '[)'),
                  s.preco_centavos, $5, app_usuario()
             from servicos s
            where s.id = $3 and s.ativo
           returning id`,
          [b.profissional_id, b.cliente_id, b.servico_id, b.inicio, b.observacao ?? ''],
        )
        if (!novo) throw new ErroApi(422, 'servico_inexistente', 'Serviço não encontrado ou inativo nesta empresa.')
        const a = await buscarAgendamento(db, novo.id)
        await enfileirarEventos(db, a, 'agendamento.criado')
        return a
      })
      return reply.status(201).send(criado)
    },
  )

  app.patch(
    '/agendamentos/:id',
    {
      preHandler: qualquer,
      schema: {
        tags: ['agenda'],
        summary: 'Mudar status ou remarcar',
        description:
          'Transições inválidas (por exemplo, reabrir um agendamento cancelado) são recusadas por um gatilho no banco ' +
          'e voltam como 422 `transicao_invalida`.',
        security: SEGURANCA,
        params: Type.Object({ id: Uuid() }),
        body: Type.Object(
          {
            status: Type.Optional(Enum(STATUS)),
            inicio: Type.Optional(Type.String({ format: 'date-time' })),
          },
          { additionalProperties: false, minProperties: 1 },
        ),
        response: { 200: Agendamento, ...Erros(400, 401, 404, 409, 422) },
      },
    },
    async (req) =>
      req.db(async (db) => {
        const n = await db.execute(
          `update agendamentos a
              set status = coalesce($2, a.status),
                  periodo = case when $3::timestamptz is null then a.periodo
                                 else tstzrange($3::timestamptz, $3::timestamptz + (upper(a.periodo) - lower(a.periodo)), '[)') end
            where a.id = $1`,
          [req.params.id, req.body.status ?? null, req.body.inicio ?? null],
        )
        if (n === 0) throw naoEncontrado('Agendamento')
        const a = await buscarAgendamento(db, req.params.id)
        await enfileirarEventos(db, a, req.body.inicio ? 'agendamento.remarcado' : `agendamento.${a.status}`)
        return a
      }),
  )
}
