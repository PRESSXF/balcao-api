import type pg from 'pg'
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'

/** Métricas no formato do Prometheus, expostas em GET /metrics. */
export function criarMetricasApi(pool: pg.Pool, opcoes: { padrao?: boolean } = {}) {
  const registro = new Registry()
  if (opcoes.padrao) collectDefaultMetrics({ register: registro, prefix: 'balcao_api_' })

  const duracao = new Histogram({
    name: 'balcao_http_request_duration_seconds',
    help: 'Duração das requisições HTTP',
    labelNames: ['metodo', 'rota', 'status'] as const,
    buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registro],
  })

  const loginFalho = new Counter({
    name: 'balcao_login_falhas_total',
    help: 'Tentativas de login recusadas',
    registers: [registro],
  })

  // Profundidade da fila lida do banco no momento da coleta, via fila_resumo()
  // (SECURITY DEFINER: só contagens, sem acesso às linhas de outras empresas).
  new Gauge({
    name: 'balcao_fila_jobs',
    help: 'Jobs na fila por tipo e status',
    labelNames: ['tipo', 'status'] as const,
    registers: [registro],
    async collect() {
      this.reset()
      const { rows } = await pool.query<{ tipo: string; status: string; total: number }>('select tipo, status, total from fila_resumo()')
      for (const r of rows) this.set({ tipo: r.tipo, status: r.status }, r.total)
    },
  })

  new Gauge({
    name: 'balcao_fila_atraso_segundos',
    help: 'Há quanto tempo o job pendente mais antigo já devia ter rodado',
    registers: [registro],
    async collect() {
      const { rows } = await pool.query<{ atraso: number | null }>(
        `select extract(epoch from now() - min(mais_antigo))::float8 as atraso
           from fila_resumo() where status = 'pendente' and mais_antigo <= now()`,
      )
      this.set(Math.max(0, rows[0]?.atraso ?? 0))
    },
  })

  new Gauge({
    name: 'balcao_db_pool_conexoes',
    help: 'Conexões do pool da API por estado',
    labelNames: ['estado'] as const,
    registers: [registro],
    collect() {
      this.set({ estado: 'total' }, pool.totalCount)
      this.set({ estado: 'ociosas' }, pool.idleCount)
      this.set({ estado: 'aguardando' }, pool.waitingCount)
    },
  })

  return { registro, duracao, loginFalho }
}

export type MetricasApi = ReturnType<typeof criarMetricasApi>
