import type pg from 'pg'
import type { Db } from '../db/pool.js'

export type TipoJob = 'lembrete_agendamento' | 'entrega_webhook'
export type StatusJob = 'pendente' | 'executando' | 'concluido' | 'morto'

export interface Job {
  id: number
  tenant_id: string
  tipo: TipoJob
  payload: Record<string, unknown>
  status: StatusJob
  tentativas: number
  max_tentativas: number
  executar_em: Date
  chave_idempotencia: string | null
}

export interface NovoJob {
  tipo: TipoJob
  payload: Record<string, unknown>
  executarEm?: Date
  chave?: string
  maxTentativas?: number
}

/**
 * Enfileira um job na empresa da transação atual (app.tenant_id). Com chave de
 * idempotência repetida, não cria outro e devolve null.
 */
export async function enfileirar(db: Db, job: NovoJob): Promise<number | null> {
  const linha = await db.maybeOne<{ id: number }>(
    `insert into jobs (tenant_id, tipo, payload, executar_em, chave_idempotencia, max_tentativas)
     values (app_tenant(), $1, $2, coalesce($3, now()), $4, coalesce($5, 5))
     on conflict (tenant_id, chave_idempotencia) do nothing
     returning id`,
    [job.tipo, JSON.stringify(job.payload), job.executarEm ?? null, job.chave ?? null, job.maxTentativas ?? null],
  )
  return linha?.id ?? null
}

/**
 * Pega até `limite` jobs prontos, de qualquer empresa. FOR UPDATE SKIP LOCKED
 * faz cada worker pular as linhas que outro já travou: dois workers nunca
 * levam o mesmo job, e nenhum fica esperando o outro.
 */
export async function pegarJobs(pool: pg.Pool, workerId: string, limite: number): Promise<Job[]> {
  const { rows } = await pool.query<Job>(
    `with proximos as (
       select id from jobs
        where status = 'pendente' and executar_em <= now()
        order by executar_em, id
        for update skip locked
        limit $2
     )
     update jobs j
        set status = 'executando', tentativas = j.tentativas + 1, travado_em = now(), travado_por = $1
       from proximos
      where j.id = proximos.id
     returning j.id, j.tenant_id, j.tipo, j.payload, j.status, j.tentativas, j.max_tentativas, j.executar_em, j.chave_idempotencia`,
    [workerId, limite],
  )
  return rows
}

export async function concluirJob(pool: pg.Pool, job: Job, workerId: string, resultado: string): Promise<boolean> {
  const r = await pool.query(
    `update jobs set status = 'concluido', concluido_em = now(), travado_em = null, travado_por = null,
                     resultado = $3, ultimo_erro = null
      where id = $1 and status = 'executando' and travado_por = $2`,
    [job.id, workerId, resultado.slice(0, 500)],
  )
  return (r.rowCount ?? 0) === 1
}

/**
 * Registra a falha. Se ainda há tentativas, volta para "pendente" com
 * executar_em no futuro (backoff exponencial); senão vai para "morto", a fila
 * de mensagens mortas, onde fica para inspeção.
 */
export async function falharJob(
  pool: pg.Pool,
  job: Job,
  workerId: string,
  erro: string,
  esperaMs: number,
): Promise<StatusJob | null> {
  const { rows } = await pool.query<{ status: StatusJob }>(
    `update jobs
        set status = case when tentativas >= max_tentativas then 'morto' else 'pendente' end,
            executar_em = case when tentativas >= max_tentativas then executar_em
                               else now() + make_interval(secs => $4::double precision / 1000) end,
            travado_em = null, travado_por = null, ultimo_erro = $3
      where id = $1 and status = 'executando' and travado_por = $2
      returning status`,
    [job.id, workerId, erro.slice(0, 1000), esperaMs],
  )
  return rows[0]?.status ?? null
}

/**
 * Jobs que ficaram "executando" além do tempo limite (o worker morreu no meio)
 * voltam para a fila, ou vão para "morto" se já gastaram as tentativas.
 */
export async function recuperarTravados(pool: pg.Pool, timeoutSeg: number): Promise<number> {
  const r = await pool.query(
    `update jobs
        set status = case when tentativas >= max_tentativas then 'morto' else 'pendente' end,
            travado_em = null, travado_por = null,
            ultimo_erro = coalesce(ultimo_erro || ' | ', '') || 'trava expirada: worker não respondeu'
      where status = 'executando' and travado_em < now() - make_interval(secs => $1)`,
    [timeoutSeg],
  )
  return r.rowCount ?? 0
}

/** Momento do próximo job agendado, para o worker dormir só o necessário. */
export async function proximoAgendado(pool: pg.Pool): Promise<Date | null> {
  const { rows } = await pool.query<{ em: Date | null }>(
    `select min(executar_em) as em from jobs where status = 'pendente'`,
  )
  return rows[0]?.em ?? null
}

/** Espera exponencial com variação aleatória de ±20% e teto. */
export function calcularEspera(
  tentativa: number,
  opcoes: { baseMs: number; maxMs: number },
  aleatorio: () => number = Math.random,
): number {
  const exp = Math.min(opcoes.maxMs, opcoes.baseMs * 2 ** Math.max(0, tentativa - 1))
  const variacao = 0.8 + aleatorio() * 0.4
  return Math.min(opcoes.maxMs, Math.round(exp * variacao))
}
