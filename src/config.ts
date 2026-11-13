import path from 'node:path'

/**
 * Configuração lida do ambiente. Em desenvolvimento, um arquivo `.env` na raiz
 * é carregado se existir (veja `.env.example`); em produção, as variáveis vêm
 * do docker compose ou do systemd.
 */

if (process.env.NODE_ENV !== 'test') {
  try {
    process.loadEnvFile()
  } catch {
    // sem .env: segue com o ambiente atual
  }
}

function texto(nome: string, padrao: string): string {
  const v = process.env[nome]
  return v === undefined || v === '' ? padrao : v
}

function inteiro(nome: string, padrao: number): number {
  const v = process.env[nome]
  if (v === undefined || v === '') return padrao
  const n = Number(v)
  if (!Number.isInteger(n)) throw new Error(`${nome} precisa ser um número inteiro (veio "${v}")`)
  return n
}

function booleano(nome: string, padrao: boolean): boolean {
  const v = process.env[nome]
  if (v === undefined || v === '') return padrao
  return ['1', 'true', 'sim', 'yes'].includes(v.toLowerCase())
}

export interface Config {
  ambiente: string
  host: string
  porta: number
  databaseUrl: string
  workerDatabaseUrl: string
  adminDatabaseUrl: string
  poolMax: number
  jwtSegredo: string
  acessoTtlSeg: number
  renovacaoTtlSeg: number
  loginLimitePorMinuto: number
  logNivel: string
  modoDemo: boolean
  urlWebhookDemo: string
  pastaMigracoes: string
  pastaConsole: string
  worker: {
    concorrencia: number
    intervaloMs: number
    travaTimeoutSeg: number
    portaMetricas: number
    latenciaWhatsappMs: number
    backoffBaseMs: number
    backoffMaxMs: number
  }
}

export function carregarConfig(): Config {
  const ambiente = texto('NODE_ENV', 'development')
  const jwtSegredo = texto('JWT_SECRET', ambiente === 'production' ? '' : 'segredo-de-desenvolvimento-com-32-caracteres-ou-mais')
  if (jwtSegredo.length < 32) {
    throw new Error('JWT_SECRET precisa ter pelo menos 32 caracteres (gere com: openssl rand -base64 48)')
  }
  return {
    ambiente,
    host: texto('HOST', '0.0.0.0'),
    porta: inteiro('PORT', 4280),
    databaseUrl: texto('DATABASE_URL', 'postgres://balcao_app:balcao_app_dev@localhost:55432/balcao'),
    workerDatabaseUrl: texto('WORKER_DATABASE_URL', 'postgres://balcao_worker:balcao_worker_dev@localhost:55432/balcao'),
    adminDatabaseUrl: texto('ADMIN_DATABASE_URL', 'postgres://balcao:balcao_dev@localhost:55432/balcao'),
    poolMax: inteiro('DB_POOL_MAX', 10),
    jwtSegredo,
    acessoTtlSeg: inteiro('ACCESS_TOKEN_TTL', 15 * 60),
    renovacaoTtlSeg: inteiro('REFRESH_TOKEN_TTL', 30 * 24 * 3600),
    loginLimitePorMinuto: inteiro('LOGIN_RATE_LIMIT', 5),
    logNivel: texto('LOG_LEVEL', 'info'),
    modoDemo: booleano('DEMO_MODE', ambiente !== 'production'),
    urlWebhookDemo: texto('DEMO_WEBHOOK_URL', 'http://localhost:4280/demo/webhooks'),
    pastaMigracoes: path.resolve(texto('MIGRATIONS_DIR', 'db/migrations')),
    pastaConsole: path.resolve(texto('CONSOLE_DIR', 'dist/console')),
    worker: {
      concorrencia: inteiro('WORKER_CONCURRENCY', 4),
      intervaloMs: inteiro('WORKER_POLL_MS', 5000),
      travaTimeoutSeg: inteiro('WORKER_LOCK_TIMEOUT', 300),
      portaMetricas: inteiro('WORKER_METRICS_PORT', 4191),
      latenciaWhatsappMs: inteiro('WHATSAPP_SIMULATED_LATENCY_MS', 700),
      backoffBaseMs: inteiro('JOB_BACKOFF_BASE_MS', 2000),
      backoffMaxMs: inteiro('JOB_BACKOFF_MAX_MS', 10 * 60 * 1000),
    },
  }
}
