import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { verificarWebhook } from '../../jobs/assinatura.js'
import { SENHA_DEMO } from '../../db/seed.js'

/**
 * Rotas que só existem com DEMO_MODE ligado (padrão fora de produção):
 * - as contas de demonstração para o console mostrar na tela de entrada;
 * - um receptor de webhooks que confere a assinatura HMAC, para a demo local
 *   ter um destino que funciona. Ele conhece o segredo de demonstração pela
 *   mesma regra do seed; um receptor real guardaria o segredo da empresa.
 */
export const rotasDemo: FastifyPluginAsyncTypebox = async (app) => {
  // Precisa do corpo cru para conferir a assinatura byte a byte.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, corpo, done) => done(null, corpo))

  app.get(
    '/contas',
    { schema: { hide: true } },
    async () => {
      const { rows } = await app.pool.query<{ slug: string; nome: string; segmento: string }>(
        `select slug, nome, segmento from tenants where slug not like 'carga-%' order by criado_em, nome limit 10`,
      )
      const usuarios: Record<string, { email: string; papel: string; nome: string }[]> = {
        'clinica-boa-vista': [
          { email: 'dono@boavista.demo', papel: 'dono', nome: 'Ana Beatriz Lopes' },
          { email: 'recepcao@boavista.demo', papel: 'atendente', nome: 'Carla Mendes' },
        ],
        'salao-mare-alta': [
          { email: 'dono@marealta.demo', papel: 'dono', nome: 'Joana Ferraz' },
          { email: 'recepcao@marealta.demo', papel: 'atendente', nome: 'Paulo Sérgio Nunes' },
        ],
        'sabor-do-capibaribe': [
          { email: 'dono@capibaribe.demo', papel: 'dono', nome: 'Severino Cunha' },
          { email: 'caixa@capibaribe.demo', papel: 'atendente', nome: 'Tainá Rocha' },
        ],
      }
      return {
        senha: SENHA_DEMO,
        empresas: rows.map((e) => ({ ...e, usuarios: usuarios[e.slug] ?? [] })),
      }
    },
  )

  app.post(
    '/webhooks/:empresa',
    { schema: { hide: true, params: Type.Object({ empresa: Type.String({ pattern: '^[a-z0-9-]{2,60}$' }) }) } },
    async (req, reply) => {
      const corpo = typeof req.body === 'string' ? req.body : ''
      const segredo = `whsec_demo_${req.params.empresa.replace(/-/g, '_')}_2026`
      const valido = verificarWebhook(corpo, req.headers['x-balcao-assinatura'] as string | undefined, segredo)
      req.log.info({ empresa: req.params.empresa, valido, entrega: req.headers['x-balcao-entrega'] }, 'webhook de demonstração recebido')
      if (!valido) return reply.status(401).send({ erro: { codigo: 'assinatura_invalida', mensagem: 'Assinatura do webhook não confere.' }, requisicao: req.id })
      return reply.status(204).send()
    },
  )
}
