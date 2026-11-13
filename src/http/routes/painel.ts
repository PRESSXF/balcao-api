import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { decodificarCursor, paginar } from '../../lib/cursor.js'
import { Enum, Erros, Pagina, Paginacao, SEGURANCA, Uuid } from '../esquemas.js'

const Data = () => Type.Unsafe<Date>({ type: 'string', format: 'date-time' })
const DataOuNulo = () => Type.Unsafe<Date | null>({ type: 'string', format: 'date-time', nullable: true })
const TextoOuNulo = () => Type.Union([Type.String(), Type.Null()])

const Job = Type.Object({
  id: Type.Integer(),
  tipo: Enum(['lembrete_agendamento', 'entrega_webhook'] as const),
  status: Enum(['pendente', 'executando', 'concluido', 'morto'] as const),
  evento: TextoOuNulo(),
  tentativas: Type.Integer(),
  max_tentativas: Type.Integer(),
  executar_em: Data(),
  criado_em: Data(),
  concluido_em: DataOuNulo(),
  ultimo_erro: TextoOuNulo(),
  resultado: TextoOuNulo(),
})

const Mensagem = Type.Object({
  id: Type.Integer(),
  canal: Enum(['whatsapp', 'webhook'] as const),
  destino: Type.String(),
  texto: TextoOuNulo(),
  status_http: Type.Union([Type.Integer(), Type.Null()]),
  job_id: Type.Union([Type.Integer(), Type.Null()]),
  criado_em: Data(),
})

const Registro = Type.Object({
  id: Type.Integer(),
  tabela: Type.String(),
  registro_id: Type.Union([Uuid(), Type.Null()]),
  acao: Enum(['INSERT', 'UPDATE', 'DELETE'] as const),
  usuario: TextoOuNulo(),
  requisicao: TextoOuNulo(),
  antes: Type.Unknown(),
  depois: Type.Unknown(),
  em: Data(),
})

export const rotasPainel: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/fila',
    {
      preHandler: app.exigir(),
      schema: {
        tags: ['painel'],
        summary: 'Jobs recentes da empresa e contagem por status',
        security: SEGURANCA,
        querystring: Type.Object({ limite: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })) }),
        response: {
          200: Type.Object({
            resumo: Type.Object({ pendente: Type.Integer(), executando: Type.Integer(), concluido: Type.Integer(), morto: Type.Integer() }),
            jobs: Type.Array(Job),
          }),
          ...Erros(401),
        },
      },
    },
    async (req) =>
      req.db(async (db) => {
        const resumo = await db.one<{ pendente: number; executando: number; concluido: number; morto: number }>(
          `select count(*) filter (where status = 'pendente')::int as pendente,
                  count(*) filter (where status = 'executando')::int as executando,
                  count(*) filter (where status = 'concluido')::int as concluido,
                  count(*) filter (where status = 'morto')::int as morto
             from jobs`,
        )
        const jobs = await db.query<Type.Static<typeof Job>>(
          `select id, tipo, status, payload ->> 'evento' as evento, tentativas, max_tentativas, executar_em,
                  criado_em, concluido_em, ultimo_erro, resultado
             from jobs order by id desc limit $1`,
          [req.query.limite ?? 25],
        )
        return { resumo, jobs }
      }),
  )

  app.get(
    '/outbox',
    {
      preHandler: app.exigir(),
      schema: {
        tags: ['painel'],
        summary: 'Mensagens enviadas (WhatsApp simulado e webhooks entregues)',
        security: SEGURANCA,
        querystring: Type.Object({ limite: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })) }),
        response: { 200: Type.Array(Mensagem), ...Erros(401) },
      },
    },
    async (req) =>
      req.db((db) =>
        db.query<Type.Static<typeof Mensagem>>(
          `select id, canal, destino, coalesce(conteudo ->> 'texto', conteudo ->> 'evento') as texto, status_http, job_id, criado_em
             from outbox order by id desc limit $1`,
          [req.query.limite ?? 20],
        ),
      ),
  )

  app.get(
    '/auditoria',
    {
      preHandler: app.exigir('dono'),
      schema: {
        tags: ['painel'],
        summary: 'Trilha de auditoria (dono)',
        description: 'Preenchida por gatilhos no banco: quem, o quê, antes e depois. A API só pode ler e inserir.',
        security: SEGURANCA,
        querystring: Type.Object({ ...Paginacao.properties, tabela: Type.Optional(Type.String({ maxLength: 40 })) }),
        response: { 200: Pagina(Registro), ...Erros(400, 401, 403) },
      },
    },
    async (req) => {
      const limite = req.query.limite ?? 20
      const cursor = decodificarCursor(req.query.cursor, ['number'])
      const linhas = await req.db((db) =>
        db.query<Type.Static<typeof Registro>>(
          `select a.id, a.tabela, a.registro_id, a.acao, u.nome as usuario, a.requisicao, a.antes, a.depois, a.em
             from auditoria a
             left join usuarios u on u.tenant_id = a.tenant_id and u.id = a.usuario_id
            where ($1::bigint is null or a.id < $1)
              and ($2::text is null or a.tabela = $2)
            order by a.id desc
            limit $3`,
          [cursor?.[0] ?? null, req.query.tabela ?? null, limite + 1],
        ),
      )
      return paginar(linhas, limite, (r) => [r.id])
    },
  )
}
