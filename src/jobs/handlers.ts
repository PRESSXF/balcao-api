import type pg from 'pg'
import { withTenant } from '../db/pool.js'
import { formatarDataHora, primeiroNome, sleep } from '../lib/formato.js'
import { assinarWebhook } from './assinatura.js'
import type { Job, TipoJob } from './fila.js'

export interface ContextoJob {
  pool: pg.Pool
  latenciaWhatsappMs: number
  fetch: typeof fetch
}

/** Devolve um texto curto com o resultado (fica em jobs.resultado). Lança para pedir nova tentativa. */
export type Handler = (job: Job, ctx: ContextoJob) => Promise<string>

export function montarLembrete(d: {
  cliente: string
  empresa: string
  servico: string
  profissional: string
  inicio: Date
  fuso: string
}): string {
  const { dia, hora } = formatarDataHora(d.inicio, d.fuso)
  return (
    `Olá, ${primeiroNome(d.cliente)}! Lembrete da ${d.empresa}: ${d.servico} com ${d.profissional} ` +
    `em ${dia} às ${hora}. Responda 1 para confirmar ou 2 para remarcar.`
  )
}

export const lembreteAgendamento: Handler = async (job, ctx) => {
  const agendamentoId = String(job.payload.agendamento_id ?? '')
  const dados = await withTenant(ctx.pool, { tenantId: job.tenant_id }, (db) =>
    db.maybeOne<{
      status: string
      inicio: Date
      cliente: string
      telefone: string
      servico: string
      profissional: string
      empresa: string
      fuso: string
    }>(
      `select a.status, lower(a.periodo) as inicio, c.nome as cliente, c.telefone,
              s.nome as servico, p.nome as profissional, t.nome as empresa, t.fuso
         from agendamentos a
         join clientes c on c.tenant_id = a.tenant_id and c.id = a.cliente_id
         join servicos s on s.tenant_id = a.tenant_id and s.id = a.servico_id
         join profissionais p on p.tenant_id = a.tenant_id and p.id = a.profissional_id
         join tenants t on t.id = a.tenant_id
        where a.id = $1`,
      [agendamentoId],
    ),
  )
  if (!dados) return 'ignorado: agendamento não existe'
  if (dados.status !== 'agendado' && dados.status !== 'confirmado') return `ignorado: agendamento ${dados.status}`
  // Remarcado depois de enfileirar: o lembrete do horário novo é outro job.
  if (typeof job.payload.inicio === 'string' && new Date(job.payload.inicio).getTime() !== new Date(dados.inicio).getTime()) {
    return 'ignorado: agendamento remarcado'
  }

  // Envio simulado: o "provedor de WhatsApp" demora um pouco e a mensagem vai
  // para a outbox. Trocar por uma API real é trocar estas duas linhas.
  await sleep(ctx.latenciaWhatsappMs)
  const texto = montarLembrete(dados)
  const inserido = await withTenant(ctx.pool, { tenantId: job.tenant_id }, (db) =>
    db.maybeOne(
      `insert into outbox (tenant_id, canal, destino, conteudo, job_id, chave)
       values (app_tenant(), 'whatsapp', $1, $2, $3, $4)
       on conflict (tenant_id, chave) do nothing
       returning id`,
      [dados.telefone, JSON.stringify({ texto }), job.id, `lembrete:${agendamentoId}:${new Date(dados.inicio).toISOString()}`],
    ),
  )
  return inserido ? 'enviado' : 'já enviado antes (efeito idempotente)'
}

export const entregaWebhook: Handler = async (job, ctx) => {
  const empresa = await withTenant(ctx.pool, { tenantId: job.tenant_id }, (db) =>
    db.maybeOne<{ webhook_url: string | null; webhook_segredo: string | null }>(
      'select webhook_url, webhook_segredo from tenants where id = app_tenant()',
    ),
  )
  if (!empresa?.webhook_url || !empresa.webhook_segredo) return 'ignorado: empresa sem webhook configurado'

  const corpo = JSON.stringify({
    id: `evt_${job.id}`,
    evento: job.payload.evento,
    ocorrido_em: job.payload.ocorrido_em,
    empresa_id: job.tenant_id,
    dados: job.payload.dados ?? {},
  })
  const resposta = await ctx.fetch(empresa.webhook_url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'balcao-webhooks/1.0',
      'x-balcao-evento': String(job.payload.evento),
      'x-balcao-entrega': `evt_${job.id}`,
      'x-balcao-tentativa': String(job.tentativas),
      'x-balcao-assinatura': assinarWebhook(corpo, empresa.webhook_segredo),
    },
    body: corpo,
    signal: AbortSignal.timeout(5000),
  })
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status} de ${new URL(empresa.webhook_url).host}`)

  await withTenant(ctx.pool, { tenantId: job.tenant_id }, (db) =>
    db.execute(
      `insert into outbox (tenant_id, canal, destino, conteudo, status_http, job_id, chave)
       values (app_tenant(), 'webhook', $1, $2, $3, $4, $5)
       on conflict (tenant_id, chave) do nothing`,
      [empresa.webhook_url, corpo, resposta.status, job.id, `webhook:${job.id}`],
    ),
  )
  return `entregue (HTTP ${resposta.status})`
}

export const HANDLERS: Record<TipoJob, Handler> = {
  lembrete_agendamento: lembreteAgendamento,
  entrega_webhook: entregaWebhook,
}
