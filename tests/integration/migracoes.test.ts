import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { carregarMigracoes, migrar, statusMigracoes } from '../../src/db/migrator.js'
import { urls } from './helpers.js'

/**
 * O executor de migrações roda num banco separado e descartável, com arquivos
 * de migração escritos pelo teste.
 */

let raiz: pg.Client
let banco: pg.Client
let pasta: string

beforeAll(async () => {
  const u = new URL(urls().admin)
  raiz = new pg.Client({ connectionString: u.toString() })
  await raiz.connect()
  await raiz.query('drop database if exists balcao_teste_migracoes with (force)')
  await raiz.query('create database balcao_teste_migracoes')
  u.pathname = '/balcao_teste_migracoes'
  banco = new pg.Client({ connectionString: u.toString() })
  await banco.connect()
  pasta = await mkdtemp(path.join(tmpdir(), 'balcao-mig-'))
  await writeFile(path.join(pasta, '0001_tabela.sql'), 'create table coisa (id int primary key);')
  await writeFile(path.join(pasta, '0002_coluna.sql'), 'alter table coisa add column nome text;')
})

afterAll(async () => {
  await banco.end()
  await raiz.query('drop database if exists balcao_teste_migracoes with (force)')
  await raiz.end()
})

describe('executor de migrações', () => {
  it('aplica em ordem e registra checksum', async () => {
    const aplicadas = await migrar(banco, await carregarMigracoes(pasta))
    expect(aplicadas.map((m) => m.versao)).toEqual(['0001', '0002'])
    const { rows } = await banco.query('select versao, length(checksum) as n from schema_migrations order by versao')
    expect(rows).toEqual([{ versao: '0001', n: 64 }, { versao: '0002', n: 64 }])
  })

  it('é idempotente: rodar de novo não faz nada', async () => {
    expect(await migrar(banco, await carregarMigracoes(pasta))).toEqual([])
  })

  it('aplica só a nova', async () => {
    await writeFile(path.join(pasta, '0003_indice.sql'), 'create index coisa_nome on coisa (nome);')
    const aplicadas = await migrar(banco, await carregarMigracoes(pasta))
    expect(aplicadas.map((m) => m.arquivo)).toEqual(['0003_indice.sql'])
  })

  it('falha numa migração quebrada sem deixar nada pela metade', async () => {
    await writeFile(path.join(pasta, '0004_quebrada.sql'), 'create table outra (id int); select * from tabela_que_nao_existe;')
    await expect(migrar(banco, await carregarMigracoes(pasta))).rejects.toThrow(/0004_quebrada\.sql/)
    const { rows } = await banco.query(`select to_regclass('outra') as t, (select count(*)::int from schema_migrations) as n`)
    expect(rows[0]).toEqual({ t: null, n: 3 })
    await writeFile(path.join(pasta, '0004_quebrada.sql'), 'create table outra (id int);')
    expect((await migrar(banco, await carregarMigracoes(pasta))).map((m) => m.versao)).toEqual(['0004'])
  })

  it('recusa rodar se uma migração aplicada foi editada', async () => {
    await writeFile(path.join(pasta, '0002_coluna.sql'), 'alter table coisa add column nome text; -- editada')
    await writeFile(path.join(pasta, '0005_nova.sql'), 'create table mais_uma (id int);')
    const locais = await carregarMigracoes(pasta)
    const status = await statusMigracoes(banco, locais)
    expect(status.find((s) => s.versao === '0002')?.estado).toBe('alterada')
    await expect(migrar(banco, locais)).rejects.toThrow(/0002_coluna \(alterada\)/)
    const { rows } = await banco.query(`select to_regclass('mais_uma') as t`)
    expect(rows[0].t).toBeNull()
  })

  it('aponta migração aplicada cujo arquivo sumiu', async () => {
    await banco.query(`insert into schema_migrations (versao, nome, checksum, duracao_ms) values ('0099', 'fantasma', 'x', 0)`)
    const status = await statusMigracoes(banco, await carregarMigracoes(pasta))
    expect(status.find((s) => s.versao === '0099')?.estado).toBe('ausente')
  })

  it('o esquema real do projeto aplica limpo e o status fica todo "aplicada"', async () => {
    const reais = await carregarMigracoes(path.resolve('db/migrations'))
    const u = new URL(urls().admin)
    const c = new pg.Client({ connectionString: u.toString() })
    await c.connect()
    try {
      const status = await statusMigracoes(c, reais)
      expect(status.every((s) => s.estado === 'aplicada')).toBe(true)
      expect(await migrar(c, reais)).toEqual([])
    } finally {
      await c.end()
    }
  })
})
