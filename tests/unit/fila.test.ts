import { describe, expect, it } from 'vitest'
import { assinarWebhook, verificarWebhook } from '../../src/jobs/assinatura.js'
import { calcularEspera } from '../../src/jobs/fila.js'
import { montarLembrete } from '../../src/jobs/handlers.js'
import { formatarCentavos } from '../../src/lib/formato.js'

describe('espera entre tentativas', () => {
  const op = { baseMs: 2000, maxMs: 600_000 }
  it('dobra a cada tentativa (sem variação)', () => {
    const meio = () => 0.5 // variação neutra (fator 1,0)
    expect([1, 2, 3, 4, 5].map((t) => calcularEspera(t, op, meio))).toEqual([2000, 4000, 8000, 16000, 32000])
  })

  it('variação fica entre 80% e 120%', () => {
    expect(calcularEspera(3, op, () => 0)).toBe(6400)
    expect(calcularEspera(3, op, () => 0.999999)).toBe(9600)
  })

  it('respeita o teto mesmo com muitas tentativas', () => {
    expect(calcularEspera(40, op, () => 0.999)).toBe(600_000)
  })
})

describe('assinatura de webhook', () => {
  const segredo = 'whsec_exemplo_com_mais_de_24_caracteres'
  const corpo = '{"evento":"pedido.criado","dados":{"total_centavos":13000}}'

  it('confere com o mesmo segredo e corpo', () => {
    const h = assinarWebhook(corpo, segredo, 1_800_000_000)
    expect(h).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/)
    expect(verificarWebhook(corpo, h, segredo, 300, 1_800_000_100)).toBe(true)
  })

  it('recusa corpo alterado, segredo errado, cabeçalho ausente e reenvio antigo', () => {
    const h = assinarWebhook(corpo, segredo, 1_800_000_000)
    expect(verificarWebhook(corpo.replace('13000', '1300'), h, segredo, 300, 1_800_000_000)).toBe(false)
    expect(verificarWebhook(corpo, h, 'outro_segredo_com_mais_de_24_chars', 300, 1_800_000_000)).toBe(false)
    expect(verificarWebhook(corpo, undefined, segredo)).toBe(false)
    expect(verificarWebhook(corpo, 't=abc,v1=00', segredo)).toBe(false)
    expect(verificarWebhook(corpo, h, segredo, 300, 1_800_000_301)).toBe(false)
  })
})

describe('mensagem de lembrete', () => {
  it('usa o primeiro nome e o horário no fuso da empresa', () => {
    const texto = montarLembrete({
      cliente: 'Marina Albuquerque',
      empresa: 'Clínica Boa Vista',
      servico: 'Limpeza de pele',
      profissional: 'Dra. Helena Cavalcanti',
      inicio: new Date('2026-11-17T13:30:00Z'),
      fuso: 'America/Recife',
    })
    expect(texto).toBe(
      'Olá, Marina! Lembrete da Clínica Boa Vista: Limpeza de pele com Dra. Helena Cavalcanti em 17/11 às 10:30. ' +
        'Responda 1 para confirmar ou 2 para remarcar.',
    )
  })

  it('outro fuso, outro horário', () => {
    const texto = montarLembrete({ cliente: 'Ana', empresa: 'E', servico: 'S', profissional: 'P', inicio: new Date('2026-11-17T13:30:00Z'), fuso: 'America/Manaus' })
    expect(texto).toContain('às 09:30')
  })
})

describe('dinheiro em centavos', () => {
  it('formata em real sem erro de ponto flutuante', () => {
    expect(formatarCentavos(10070).replace(/\s/g, ' ')).toBe('R$ 100,70')
    expect(formatarCentavos(0).replace(/\s/g, ' ')).toBe('R$ 0,00')
  })
})
