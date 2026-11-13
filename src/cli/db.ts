import pg from 'pg'
import { carregarConfig } from '../config.js'
import { carregarMigracoes, ErroMigracao, migrar, statusMigracoes } from '../db/migrator.js'
import { sincronizarPapeis } from '../db/papeis.js'
import { semear, semearCarga } from '../db/seed.js'

/**
 * Comandos de banco. Conectam com ADMIN_DATABASE_URL (dono das tabelas).
 *
 *   migrar            aplica migrações pendentes
 *   status            lista migrações e estado (aplicada, pendente, alterada, ausente)
 *   papeis            liga login e senha de balcao_app e balcao_worker
 *   semear            dados de demonstração (só se o banco estiver vazio)
 *   semear --carga    volume sintético para EXPLAIN e teste de carga
 *   preparar          migrar + papeis + semear (usado pelo docker compose)
 */

const USO = 'uso: db <migrar|status|papeis|semear [--carga]|preparar>'

async function main(): Promise<number> {
  const [comando, ...flags] = process.argv.slice(2)
  if (!comando) {
    console.error(USO)
    return 2
  }
  const config = carregarConfig()
  const client = new pg.Client({ connectionString: config.adminDatabaseUrl, application_name: 'balcao-cli' })
  await client.connect()
  try {
    const migracoes = await carregarMigracoes(config.pastaMigracoes)
    switch (comando) {
      case 'migrar': {
        const aplicadas = await migrar(client, migracoes, (m) => console.log(m))
        console.log(aplicadas.length === 0 ? 'Nada a migrar: banco em dia.' : `${aplicadas.length} migração(ões) aplicada(s).`)
        return 0
      }
      case 'status': {
        const status = await statusMigracoes(client, migracoes)
        for (const s of status) {
          const quando = s.aplicadaEm ? s.aplicadaEm.toISOString() : ''
          console.log(`${s.versao}  ${s.estado.padEnd(9)}  ${s.nome.padEnd(32)} ${quando}`)
        }
        const ruins = status.filter((s) => s.estado === 'alterada' || s.estado === 'ausente')
        return ruins.length > 0 ? 1 : 0
      }
      case 'papeis': {
        const feitos = await sincronizarPapeis(client, [config.databaseUrl, config.workerDatabaseUrl])
        console.log(`Login e senha definidos para: ${feitos.join(', ')}`)
        return 0
      }
      case 'semear': {
        if (flags.includes('--carga')) {
          const r = await semearCarga(client)
          console.log(`Carga: ${r.empresas} empresas; total no banco: ${r.clientes} clientes, ${r.agendamentos} agendamentos.`)
          return 0
        }
        return await semearSeVazio(client, config.urlWebhookDemo)
      }
      case 'preparar': {
        await migrar(client, migracoes, (m) => console.log(m))
        await sincronizarPapeis(client, [config.databaseUrl, config.workerDatabaseUrl])
        console.log('Migrações e papéis prontos.')
        if (config.modoDemo) await semearSeVazio(client, config.urlWebhookDemo)
        return 0
      }
      default:
        console.error(USO)
        return 2
    }
  } finally {
    await client.end()
  }
}

async function semearSeVazio(client: pg.Client, urlWebhookDemo: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>('select count(*)::int as n from tenants')
  if (rows[0]!.n > 0) {
    console.log('Banco já tem empresas; dados de demonstração não foram inseridos.')
    return 0
  }
  const r = await semear(client, { urlWebhookDemo })
  console.log(`Dados de demonstração inseridos: ${r.empresas} empresas.`)
  return 0
}

main().then(
  (codigo) => process.exit(codigo),
  (err: unknown) => {
    if (err instanceof ErroMigracao) console.error(err.message)
    else console.error(err)
    process.exit(1)
  },
)
