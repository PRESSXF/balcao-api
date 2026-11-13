import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { emitirAcesso, type Papel } from '../../auth/jwt.js'
import { consumirRenovacao, emitirRenovacao, lerTokenRenovacao, revogarFamilia } from '../../auth/renovacao.js'
import { hashParaComparacaoCega, verificarSenha } from '../../auth/senha.js'
import { withTenant } from '../../db/pool.js'
import { ErroApi } from '../erros.js'
import { Enum, Erros, SEGURANCA, Uuid } from '../esquemas.js'

const Sessao = Type.Object({
  acesso: Type.String({ description: 'JWT de acesso (curto). Envie em Authorization: Bearer' }),
  acesso_expira_em: Type.Unsafe<Date>({ type: 'string', format: 'date-time' }),
  renovacao: Type.String({ description: 'Token de renovação de uso único. Guarde com cuidado.' }),
  renovacao_expira_em: Type.Unsafe<Date>({ type: 'string', format: 'date-time' }),
  usuario: Type.Object({ id: Uuid(), nome: Type.String(), email: Type.String(), papel: Enum(['dono', 'atendente'] as const) }),
  empresa: Type.Object({ id: Uuid(), slug: Type.String(), nome: Type.String(), segmento: Type.String(), fuso: Type.String() }),
})

const CREDENCIAIS = 'Empresa, e-mail ou senha incorretos.'

interface LinhaUsuario {
  id: string
  nome: string
  email: string
  papel: Papel
  senha_hash: string
  ativo: boolean
  [k: string]: unknown
}
interface LinhaEmpresa {
  id: string
  slug: string
  nome: string
  segmento: string
  fuso: string
  [k: string]: unknown
}

export const rotasAuth: FastifyPluginAsyncTypebox = async (app) => {
  const { config, pool } = app

  async function abrirSessao(empresa: LinhaEmpresa, usuario: LinhaUsuario, familia?: string) {
    const acesso = emitirAcesso({ usuarioId: usuario.id, tenantId: empresa.id, papel: usuario.papel }, config.jwtSegredo, config.acessoTtlSeg)
    const renovacao = await withTenant(pool, { tenantId: empresa.id, usuarioId: usuario.id }, (db) =>
      emitirRenovacao(db, { tenantId: empresa.id, usuarioId: usuario.id, familia, ttlSeg: config.renovacaoTtlSeg }),
    )
    return {
      acesso: acesso.token,
      acesso_expira_em: acesso.expiraEm,
      renovacao: renovacao.token,
      renovacao_expira_em: renovacao.expiraEm,
      usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email, papel: usuario.papel },
      empresa: { id: empresa.id, slug: empresa.slug, nome: empresa.nome, segmento: empresa.segmento, fuso: empresa.fuso },
    }
  }

  app.post(
    '/auth/login',
    {
      config: {
        rateLimit: {
          max: config.loginLimitePorMinuto,
          timeWindow: '1 minute',
          errorResponseBuilder: (_req, ctx) =>
            new ErroApi(429, 'muitas_tentativas', `Muitas tentativas de login. Tente de novo em ${Math.ceil(ctx.ttl / 1000)} s.`),
        },
      },
      schema: {
        tags: ['autenticação'],
        summary: 'Entrar',
        description: `Limite de ${config.loginLimitePorMinuto} tentativas por minuto por IP. A resposta de erro é a mesma para empresa, e-mail ou senha errados.`,
        body: Type.Object(
          {
            empresa: Type.String({ minLength: 2, maxLength: 60, description: 'Slug da empresa, ex.: clinica-boa-vista' }),
            email: Type.String({ format: 'email', maxLength: 200 }),
            senha: Type.String({ minLength: 1, maxLength: 200 }),
          },
          { additionalProperties: false },
        ),
        response: { 200: Sessao, ...Erros(400, 401, 429) },
      },
    },
    async (req) => {
      const { empresa: slug, email, senha } = req.body
      const empresa = await pool
        .query<LinhaEmpresa>('select id, slug, nome, segmento, fuso from tenants where slug = $1', [slug])
        .then((r) => r.rows[0] ?? null)
      const usuario = empresa
        ? await withTenant(pool, { tenantId: empresa.id, requisicaoId: req.id }, (db) =>
            db.maybeOne<LinhaUsuario>('select id, nome, email, papel, senha_hash, ativo from usuarios where email = $1', [email]),
          )
        : null
      // Compara mesmo sem usuário, para o tempo de resposta não revelar se o e-mail existe.
      const confere = await verificarSenha(senha, usuario?.senha_hash ?? (await hashParaComparacaoCega()))
      if (!empresa || !usuario || !usuario.ativo || !confere) {
        app.metricas.loginFalho.inc()
        throw new ErroApi(401, 'credenciais_invalidas', CREDENCIAIS)
      }
      return abrirSessao(empresa, usuario)
    },
  )

  app.post(
    '/auth/renovar',
    {
      schema: {
        tags: ['autenticação'],
        summary: 'Trocar o token de renovação por uma sessão nova',
        description:
          'O token usado deixa de valer. Se um token já usado for apresentado de novo, a família inteira é revogada (indício de roubo).',
        body: Type.Object({ renovacao: Type.String({ minLength: 10, maxLength: 200 }) }, { additionalProperties: false }),
        response: { 200: Sessao, ...Erros(400, 401) },
      },
    },
    async (req) => {
      const lido = lerTokenRenovacao(req.body.renovacao)
      if (!lido) throw new ErroApi(401, 'renovacao_invalida', 'Token de renovação inválido. Faça login de novo.')

      const empresa = await pool
        .query<LinhaEmpresa>('select id, slug, nome, segmento, fuso from tenants where id = $1', [lido.tenantId])
        .then((r) => r.rows[0] ?? null)
      if (!empresa) throw new ErroApi(401, 'renovacao_invalida', 'Token de renovação inválido. Faça login de novo.')

      // A revogação por reuso precisa ser gravada (COMMIT) mesmo com a resposta sendo um erro.
      const r = await withTenant(pool, { tenantId: lido.tenantId, requisicaoId: req.id }, async (db) => {
        const rot = await consumirRenovacao(db, lido)
        if (!rot.ok) return { rot, usuario: null }
        const usuario = await db.one<LinhaUsuario>('select id, nome, email, papel, senha_hash, ativo from usuarios where id = $1', [rot.usuarioId])
        return { rot, usuario }
      })
      if (!r.rot.ok || !r.usuario) {
        const motivo = r.rot.ok ? 'inexistente' : r.rot.motivo
        if (motivo === 'reutilizado') {
          req.log.warn({ tenant: lido.tenantId }, 'token de renovação reutilizado; família revogada')
          throw new ErroApi(401, 'renovacao_reutilizada', 'Este token de renovação já foi usado. Por segurança, todas as sessões dele foram encerradas.')
        }
        throw new ErroApi(401, 'renovacao_invalida', 'Token de renovação inválido ou expirado. Faça login de novo.')
      }
      return abrirSessao(empresa, r.usuario, r.rot.familia)
    },
  )

  app.post(
    '/auth/sair',
    {
      schema: {
        tags: ['autenticação'],
        summary: 'Encerrar a sessão (revoga a família do token de renovação)',
        body: Type.Object({ renovacao: Type.String({ minLength: 10, maxLength: 200 }) }, { additionalProperties: false }),
        response: { 204: Type.Null(), ...Erros(400) },
      },
    },
    async (req, reply) => {
      const lido = lerTokenRenovacao(req.body.renovacao)
      if (lido) {
        await withTenant(pool, { tenantId: lido.tenantId, requisicaoId: req.id }, async (db) => {
          const linha = await db.maybeOne<{ familia: string }>('select familia from refresh_tokens where id = $1', [lido.id])
          if (linha) await revogarFamilia(db, linha.familia)
        })
      }
      return reply.status(204).send(null)
    },
  )

  app.get(
    '/eu',
    {
      preHandler: app.exigir(),
      schema: {
        tags: ['autenticação'],
        summary: 'Usuário autenticado e empresa',
        security: SEGURANCA,
        response: {
          200: Type.Object({ usuario: Sessao.properties.usuario, empresa: Sessao.properties.empresa }),
          ...Erros(401),
        },
      },
    },
    async (req) =>
      req.db(async (db) => {
        const usuario = await db.one<LinhaUsuario>('select id, nome, email, papel, senha_hash, ativo from usuarios where id = app_usuario()')
        const empresa = await db.one<LinhaEmpresa>('select id, slug, nome, segmento, fuso from tenants where id = app_tenant()')
        return {
          usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email, papel: usuario.papel },
          empresa,
        }
      }),
  )
}
