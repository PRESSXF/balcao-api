import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { carregarMigracoes, checksum, compararMigracoes, parseMigracao } from '../../src/db/migrator.js'

describe('arquivos de migração', () => {
  it('lê versão, nome e checksum', () => {
    const m = parseMigracao('0003_agenda_e_pedidos.sql', 'select 1;')
    expect(m).toMatchObject({ versao: '0003', nome: 'agenda_e_pedidos', semTransacao: false })
    expect(m.checksum).toHaveLength(64)
  })

  it('recusa nome fora do padrão', () => {
    expect(() => parseMigracao('3_x.sql', '')).toThrow(/NNNN_nome/)
    expect(() => parseMigracao('0003-Agenda.sql', '')).toThrow()
  })

  it('checksum ignora diferença de fim de linha', () => {
    expect(checksum('a\r\nb')).toBe(checksum('a\nb'))
    expect(checksum('a\nb')).not.toBe(checksum('a\nb '))
  })

  it('marca de sem transação no topo', () => {
    expect(parseMigracao('0009_x.sql', '-- balcao:sem-transacao\ncreate index concurrently x on y (z);').semTransacao).toBe(true)
  })

  it('as migrações do projeto estão em sequência sem buracos', async () => {
    const ms = await carregarMigracoes(path.resolve('db/migrations'))
    expect(ms.map((m) => Number(m.versao))).toEqual(ms.map((_, i) => i + 1))
  })
})

describe('comparação com o banco', () => {
  const locais = [parseMigracao('0001_a.sql', 'a'), parseMigracao('0002_b.sql', 'b'), parseMigracao('0003_c.sql', 'c')]
  const em = new Date('2026-11-01T00:00:00Z')

  it('aplicada, pendente, alterada e ausente', () => {
    const status = compararMigracoes(locais, [
      { versao: '0001', nome: 'a', checksum: locais[0]!.checksum, aplicada_em: em },
      { versao: '0002', nome: 'b', checksum: 'outro', aplicada_em: em },
      { versao: '0000', nome: 'velha', checksum: 'x', aplicada_em: em },
    ])
    expect(status.map((s) => [s.versao, s.estado])).toEqual([
      ['0000', 'ausente'],
      ['0001', 'aplicada'],
      ['0002', 'alterada'],
      ['0003', 'pendente'],
    ])
  })
})
