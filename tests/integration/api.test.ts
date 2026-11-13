import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { emitirAcesso } from '../../src/auth/jwt.js'
import type { App } from '../../src/http/app.js'
import { A, B, abrirAmbiente, auth, configTeste, criarApp, idsDe, login, resetar, type Ambiente } from './helpers.js'

let amb: Ambiente
let app: App
let dono: string
let atendente: string
let donoB: string

beforeAll(async () => {
  amb = abrirAmbiente()
  await resetar(amb.admin)
  app = await criarApp(amb.app)
  dono = (await login(app, 'clinica-boa-vista', 'dono@boavista.demo')).acesso
  atendente = (await login(app, 'clinica-boa-vista', 'recepcao@boavista.demo')).acesso
  donoB = (await login(app, 'salao-mare-alta', 'dono@marealta.demo')).acesso
})
afterAll(async () => {
  await app.close()
  await amb.fechar()
})

describe('login', () => {
  it('devolve acesso, renovação, usuário e empresa', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { empresa: 'clinica-boa-vista', email: 'DONO@boavista.demo', senha: 'balcao123' } })
    expect(r.statusCode).toBe(200)
    const s = r.json()
    expect(s.usuario).toMatchObject({ nome: 'Ana Beatriz Lopes', papel: 'dono' })
    expect(s.empresa).toMatchObject({ id: A, slug: 'clinica-boa-vista', fuso: 'America/Recife' })
    expect(s.acesso.split('.')).toHaveLength(3)
    expect(s.renovacao.startsWith(`${A}.`)).toBe(true)
  })

  it('mesma resposta para senha errada, e-mail inexistente e empresa inexistente', async () => {
    const casos = [
      { empresa: 'clinica-boa-vista', email: 'dono@boavista.demo', senha: 'errada' },
      { empresa: 'clinica-boa-vista', email: 'ninguem@boavista.demo', senha: 'balcao123' },
      { empresa: 'nao-existe', email: 'dono@boavista.demo', senha: 'balcao123' },
      // usuário de outra empresa não entra pela clínica
      { empresa: 'clinica-boa-vista', email: 'dono@marealta.demo', senha: 'balcao123' },
    ]
    for (const payload of casos) {
      const r = await app.inject({ method: 'POST', url: '/v1/auth/login', payload })
      expect(r.statusCode).toBe(401)
      expect(r.json().erro).toEqual({ codigo: 'credenciais_invalidas', mensagem: 'Empresa, e-mail ou senha incorretos.' })
    }
  })

  it('limita tentativas de login por IP com mensagem em português', async () => {
    const limitado = await criarApp(amb.app, { loginLimitePorMinuto: 3 })
    try {
      const payload = { empresa: 'clinica-boa-vista', email: 'dono@boavista.demo', senha: 'errada' }
      const codigos: number[] = []
      for (let i = 0; i < 5; i++) codigos.push((await limitado.inject({ method: 'POST', url: '/v1/auth/login', payload, remoteAddress: '10.1.1.1' })).statusCode)
      expect(codigos).toEqual([401, 401, 401, 429, 429])
      const r = await limitado.inject({ method: 'POST', url: '/v1/auth/login', payload, remoteAddress: '10.1.1.1' })
      expect(r.json().erro.codigo).toBe('muitas_tentativas')
      expect(r.json().erro.mensagem).toMatch(/^Muitas tentativas de login/)
      // Outro IP continua podendo tentar.
      expect((await limitado.inject({ method: 'POST', url: '/v1/auth/login', payload, remoteAddress: '10.1.1.2' })).statusCode).toBe(401)
    } finally {
      await limitado.close()
    }
  })
})

describe('token de acesso', () => {
  it('exige Bearer', async () => {
    const r = await app.inject({ url: '/v1/agenda' })
    expect(r.statusCode).toBe(401)
    expect(r.json().erro.codigo).toBe('nao_autenticado')
  })

  it('recusa token adulterado e token expirado', async () => {
    const [h, c, s] = dono.split('.')
    const corpo = JSON.parse(Buffer.from(c!, 'base64url').toString())
    const trocado = Buffer.from(JSON.stringify({ ...corpo, tid: B })).toString('base64url')
    const r1 = await app.inject({ url: '/v1/clientes', headers: auth(`${h}.${trocado}.${s}`) })
    expect(r1.json().erro.codigo).toBe('token_invalido')

    const cfg = configTeste()
    const velho = emitirAcesso({ usuarioId: corpo.sub, tenantId: A, papel: 'dono' }, cfg.jwtSegredo, 60, Date.now() - 120_000)
    const r2 = await app.inject({ url: '/v1/clientes', headers: auth(velho.token) })
    expect(r2.statusCode).toBe(401)
    expect(r2.json().erro.codigo).toBe('token_expirado')
  })
})

describe('renovação rotativa', () => {
  it('troca o par, invalida o usado e revoga a família quando um usado reaparece', async () => {
    const s1 = await login(app, 'clinica-boa-vista', 'recepcao@boavista.demo')
    const r2 = await app.inject({ method: 'POST', url: '/v1/auth/renovar', payload: { renovacao: s1.renovacao } })
    expect(r2.statusCode).toBe(200)
    const s2 = r2.json()
    expect(s2.renovacao).not.toBe(s1.renovacao)

    // Alguém reapresenta o token antigo: recusado, e a família toda cai.
    const roubo = await app.inject({ method: 'POST', url: '/v1/auth/renovar', payload: { renovacao: s1.renovacao } })
    expect(roubo.statusCode).toBe(401)
    expect(roubo.json().erro.codigo).toBe('renovacao_reutilizada')
    const legitimo = await app.inject({ method: 'POST', url: '/v1/auth/renovar', payload: { renovacao: s2.renovacao } })
    expect(legitimo.statusCode).toBe(401)

    const { rows } = await amb.admin.query(
      `select count(*) filter (where revogado_em is null)::int as ativos, count(*)::int as total
         from refresh_tokens where familia = (select familia from refresh_tokens where id = $1)`,
      [s1.renovacao.split('.')[1]],
    )
    expect(rows[0]).toEqual({ ativos: 0, total: 2 })
  })

  it('guarda só o hash do segredo', async () => {
    const s = await login(app, 'clinica-boa-vista', 'recepcao@boavista.demo')
    const [, id, segredo] = s.renovacao.split('.')
    const { rows } = await amb.admin.query(`select encode(token_hash, 'hex') as h from refresh_tokens where id = $1`, [id])
    expect(rows[0].h).toHaveLength(64)
    expect(rows[0].h).not.toContain(Buffer.from(segredo!, 'base64url').toString('hex'))
  })

  it('sair revoga a sessão', async () => {
    const s = await login(app, 'clinica-boa-vista', 'recepcao@boavista.demo')
    expect((await app.inject({ method: 'POST', url: '/v1/auth/sair', payload: { renovacao: s.renovacao } })).statusCode).toBe(204)
    expect((await app.inject({ method: 'POST', url: '/v1/auth/renovar', payload: { renovacao: s.renovacao } })).statusCode).toBe(401)
  })

  it('token malformado ou de empresa inexistente', async () => {
    for (const renovacao of ['abc.def.ghi', `00000000-0000-4000-8000-000000000000.00000000-0000-4000-8000-000000000000.${'a'.repeat(43)}`]) {
      const r = await app.inject({ method: 'POST', url: '/v1/auth/renovar', payload: { renovacao } })
      expect(r.statusCode).toBe(401)
      expect(r.json().erro.codigo).toBe('renovacao_invalida')
    }
  })
})

describe('papéis por rota', () => {
  it('atendente não lê auditoria nem cadastra serviço; dono pode', async () => {
    const aud = await app.inject({ url: '/v1/auditoria', headers: auth(atendente) })
    expect(aud.statusCode).toBe(403)
    expect(aud.json().erro).toEqual({ codigo: 'papel_insuficiente', mensagem: 'Esta ação exige o papel: dono.' })
    const serv = await app.inject({ method: 'POST', url: '/v1/servicos', headers: auth(atendente), payload: { nome: 'Peeling', duracao_min: 40, preco_centavos: 20000 } })
    expect(serv.statusCode).toBe(403)
    expect((await app.inject({ url: '/v1/auditoria', headers: auth(dono) })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/v1/servicos', headers: auth(dono), payload: { nome: 'Peeling', duracao_min: 40, preco_centavos: 20000 } })).statusCode).toBe(201)
  })
})

describe('validação em português', () => {
  it('lista cada campo inválido', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/clientes', headers: auth(atendente), payload: { telefone: '8199', email: 'nao-e-email', apelido: 'x' } })
    expect(r.statusCode).toBe(400)
    const e = r.json()
    expect(e.erro.codigo).toBe('validacao')
    expect(e.requisicao).toMatch(/^req-/)
    expect(e.erro.detalhes).toEqual(
      expect.arrayContaining([
        { campo: 'nome', mensagem: 'é obrigatório' },
        { campo: 'telefone', mensagem: 'está em um formato inválido' },
        { campo: 'email', mensagem: 'deve ser um e-mail válido' },
        { campo: 'apelido', mensagem: 'não é permitido' },
      ]),
    )
  })

  it('query, parâmetro e rota inexistente também em português', async () => {
    const q = await app.inject({ url: '/v1/agenda?dia=16/11/2026', headers: auth(dono) })
    expect(q.json().erro.detalhes).toEqual([{ campo: 'query.dia', mensagem: 'deve ser uma data no formato AAAA-MM-DD' }])
    const p = await app.inject({ url: '/v1/clientes/123', headers: auth(dono) })
    expect(p.json().erro.detalhes).toEqual([{ campo: 'parametro.id', mensagem: 'deve ser um identificador UUID' }])
    const n = await app.inject({ url: '/v1/nada' })
    expect(n.statusCode).toBe(404)
    expect(n.json().erro.codigo).toBe('rota_inexistente')
  })

  it('JSON malformado', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/clientes', headers: { ...auth(dono), 'content-type': 'application/json' }, payload: '{"nome": ' })
    expect(r.statusCode).toBe(400)
    expect(r.json().erro.codigo).toBe('requisicao_invalida')
  })
})

describe('isolamento pela API', () => {
  it('cliente de outra empresa responde 404, como se não existisse', async () => {
    const { clientes } = await idsDe(amb.admin, B)
    const r = await app.inject({ url: `/v1/clientes/${clientes[0]}`, headers: auth(dono) })
    expect(r.statusCode).toBe(404)
    expect((await app.inject({ url: `/v1/clientes/${clientes[0]}`, headers: auth(donoB) })).statusCode).toBe(200)
  })

  it('agendar com profissional de outra empresa é recusado', async () => {
    const a = await idsDe(amb.admin, A)
    const b = await idsDe(amb.admin, B)
    const r = await app.inject({
      method: 'POST',
      url: '/v1/agendamentos',
      headers: auth(dono),
      payload: { profissional_id: b.profissionais[0], cliente_id: a.clientes[0], servico_id: a.servicos[0], inicio: '2026-12-10T10:00:00-03:00' },
    })
    expect(r.statusCode).toBe(422)
    expect(r.json().erro.codigo).toBe('referencia_invalida')
  })
})

describe('paginação por cursor', () => {
  it('percorre todos os clientes sem repetir nem pular', async () => {
    const vistos: string[] = []
    let cursor: string | null = null
    let paginas = 0
    do {
      const url: string = `/v1/clientes?limite=5${cursor ? `&cursor=${cursor}` : ''}`
      const r: Awaited<ReturnType<App['inject']>> = await app.inject({ url, headers: auth(dono) })
      expect(r.statusCode).toBe(200)
      const pagina: { itens: { id: string; nome: string }[]; proximo: string | null } = r.json()
      vistos.push(...pagina.itens.map((c) => c.id))
      cursor = pagina.proximo
      paginas++
    } while (cursor && paginas < 20)
    const total = (await amb.admin.query('select count(*)::int as n from clientes where tenant_id = $1', [A])).rows[0].n
    expect(vistos).toHaveLength(total)
    expect(new Set(vistos).size).toBe(total)
    expect(paginas).toBe(Math.ceil(total / 5))
  })

  it('cursor adulterado é 400', async () => {
    const r = await app.inject({ url: '/v1/clientes?cursor=bGl4bw', headers: auth(dono) })
    expect(r.statusCode).toBe(400)
    expect(r.json().erro.codigo).toBe('cursor_invalido')
  })
})

describe('agendamentos', () => {
  it('cria com fim e preço do serviço, enfileira lembrete e webhook e recusa sobreposição com 409', async () => {
    const a = await idsDe(amb.admin, A)
    const servico = (await amb.admin.query(`select id, duracao_min, preco_centavos from servicos where tenant_id = $1 and nome = 'Limpeza de pele'`, [A])).rows[0]
    const corpo = { profissional_id: a.profissionais[0], cliente_id: a.clientes[3], servico_id: servico.id, inicio: '2026-12-11T15:00:00-03:00' }
    const r = await app.inject({ method: 'POST', url: '/v1/agendamentos', headers: auth(atendente), payload: corpo })
    expect(r.statusCode).toBe(201)
    const ag = r.json()
    expect(new Date(ag.fim).getTime() - new Date(ag.inicio).getTime()).toBe(servico.duracao_min * 60_000)
    expect(ag.preco_centavos).toBe(servico.preco_centavos)

    const jobs = (
      await amb.admin.query(
        `select tipo, payload ->> 'evento' as evento from jobs
          where tenant_id = $1 and (payload ->> 'agendamento_id' = $2 or payload -> 'dados' ->> 'agendamento_id' = $2)
          order by id`,
        [A, ag.id],
      )
    ).rows
    expect(jobs).toEqual([
      { tipo: 'lembrete_agendamento', evento: null },
      { tipo: 'entrega_webhook', evento: 'agendamento.criado' },
    ])

    const conflito = await app.inject({ method: 'POST', url: '/v1/agendamentos', headers: auth(atendente), payload: { ...corpo, inicio: '2026-12-11T15:30:00-03:00' } })
    expect(conflito.statusCode).toBe(409)
    expect(conflito.json().erro).toMatchObject({
      codigo: 'conflito_horario',
      mensagem: 'Este profissional já tem um agendamento que se sobrepõe a esse horário.',
      detalhes: [{ restricao: 'agendamentos_sem_sobreposicao' }],
    })
    // Nada da tentativa recusada ficou na fila (mesma transação).
    const totalJobs = (await amb.admin.query(`select count(*)::int as n from jobs where tenant_id = $1 and payload -> 'dados' ->> 'inicio' like '2026-12-11T18:30%'`, [A])).rows[0].n
    expect(totalJobs).toBe(0)
  })

  it('cancelar e tentar reabrir: 422 com a mensagem do gatilho', async () => {
    const lista = await app.inject({ url: '/v1/agenda?dia=2026-11-16', headers: auth(dono) })
    const ag = lista.json().agendamentos[0]
    expect((await app.inject({ method: 'PATCH', url: `/v1/agendamentos/${ag.id}`, headers: auth(dono), payload: { status: 'cancelado' } })).statusCode).toBe(200)
    const r = await app.inject({ method: 'PATCH', url: `/v1/agendamentos/${ag.id}`, headers: auth(dono), payload: { status: 'agendado' } })
    expect(r.statusCode).toBe(422)
    expect(r.json().erro.codigo).toBe('transicao_invalida')
    expect(r.json().erro.mensagem).toMatch(/não pode sair do status "cancelado"/)
  })

  it('agenda do dia vem no fuso da empresa e em ordem', async () => {
    const r = await app.inject({ url: '/v1/agenda?dia=2026-11-17', headers: auth(dono) })
    const { agendamentos, fuso, profissionais } = r.json()
    expect(fuso).toBe('America/Recife')
    expect(profissionais).toHaveLength(3)
    const horas = agendamentos.map((a: { inicio: string }) => new Date(a.inicio).toLocaleTimeString('pt-BR', { timeZone: 'America/Recife', hour: '2-digit', minute: '2-digit' }))
    expect(horas.length).toBeGreaterThan(5)
    expect([...horas].sort()).toEqual(horas)
    expect(horas.every((h: string) => h >= '07:30' && h <= '17:00')).toBe(true)
  })
})

describe('pedidos com Idempotency-Key', () => {
  const corpo = { itens: [{ descricao: 'Máscara de hidratação 250 g', quantidade: 2, preco_unitario_centavos: 4890 }, { descricao: 'Óleo para barba 30 ml', quantidade: 1, preco_unitario_centavos: 3200 }] }

  it('exige o cabeçalho', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/pedidos', headers: auth(donoB), payload: corpo })
    expect(r.statusCode).toBe(400)
    expect(r.json().erro.detalhes).toEqual([{ campo: 'cabecalho.idempotency-key', mensagem: 'é obrigatório' }])
  })

  it('repetir devolve o mesmo pedido; total vem do banco', async () => {
    const h = { ...auth(donoB), 'idempotency-key': 'pedido-teste-0001' }
    const r1 = await app.inject({ method: 'POST', url: '/v1/pedidos', headers: h, payload: corpo })
    expect(r1.statusCode).toBe(201)
    expect(r1.json().total_centavos).toBe(2 * 4890 + 3200)
    const r2 = await app.inject({ method: 'POST', url: '/v1/pedidos', headers: h, payload: corpo })
    expect(r2.statusCode).toBe(200)
    expect(r2.headers['idempotent-replayed']).toBe('true')
    expect(r2.json().id).toBe(r1.json().id)
  })

  it('mesma chave com outro corpo é 422', async () => {
    const h = { ...auth(donoB), 'idempotency-key': 'pedido-teste-0001' }
    const r = await app.inject({ method: 'POST', url: '/v1/pedidos', headers: h, payload: { itens: [{ descricao: 'Outro', quantidade: 1, preco_unitario_centavos: 100 }] } })
    expect(r.statusCode).toBe(422)
    expect(r.json().erro.codigo).toBe('chave_reutilizada')
  })

  it('8 requisições simultâneas com a mesma chave criam um pedido só', async () => {
    const h = { ...auth(donoB), 'idempotency-key': 'pedido-concorrente-42' }
    const rs = await Promise.all(Array.from({ length: 8 }, () => app.inject({ method: 'POST', url: '/v1/pedidos', headers: h, payload: corpo })))
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201])
    expect(new Set(rs.map((r) => r.json().id)).size).toBe(1)
    const { rows } = await amb.admin.query(`select count(*)::int as n from pedidos where chave_idempotencia = 'pedido-concorrente-42'`)
    expect(rows[0].n).toBe(1)
    const webhooks = await amb.admin.query(`select count(*)::int as n from jobs where payload -> 'dados' ->> 'pedido_id' = $1`, [rs[0]!.json().id])
    expect(webhooks.rows[0].n).toBe(1)
  })

  it('a mesma chave em outra empresa é outro pedido', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/pedidos', headers: { ...auth(dono), 'idempotency-key': 'pedido-teste-0001' }, payload: corpo })
    expect(r.statusCode).toBe(201)
  })
})

describe('auditoria pela API', () => {
  it('mostra quem criou o cliente, pelo nome', async () => {
    const c = await app.inject({ method: 'POST', url: '/v1/clientes', headers: auth(atendente), payload: { nome: 'Rita de Cássia Prado', telefone: '+5581987650001' } })
    expect(c.statusCode).toBe(201)
    const r = await app.inject({ url: '/v1/auditoria?tabela=clientes&limite=1', headers: auth(dono) })
    expect(r.json().itens[0]).toMatchObject({ tabela: 'clientes', acao: 'INSERT', usuario: 'Carla Mendes', registro_id: c.json().id })
    expect(r.json().itens[0].requisicao).toMatch(/^req-/)
  })

  it('telefone repetido é 409 em português', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/clientes', headers: auth(atendente), payload: { nome: 'Outra Rita', telefone: '+5581987650001' } })
    expect(r.statusCode).toBe(409)
    expect(r.json().erro).toMatchObject({ codigo: 'telefone_duplicado', mensagem: 'Já existe um cliente com esse telefone.' })
  })
})

describe('operação', () => {
  it('/health, /ready e /metrics', async () => {
    expect((await app.inject({ url: '/health' })).json()).toEqual({ status: 'ok' })
    const ready = await app.inject({ url: '/ready' })
    expect(ready.statusCode).toBe(200)
    expect(ready.json()).toMatchObject({ status: 'pronto', migracao: '0008' })
    const m = await app.inject({ url: '/metrics' })
    expect(m.body).toContain('balcao_http_request_duration_seconds_bucket')
    expect(m.body).toMatch(/balcao_fila_jobs\{tipo="entrega_webhook",status="pendente"\} \d+/)
    expect(m.body).toContain('balcao_login_falhas_total')
  })

  it('OpenAPI gerado a partir dos esquemas das rotas', async () => {
    const r = await app.inject({ url: '/docs/json' })
    const doc = r.json()
    expect(doc.openapi).toBe('3.0.3')
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/v1/auth/login', '/v1/agendamentos', '/v1/pedidos', '/v1/clientes', '/v1/fila', '/v1/auditoria']))
    expect(doc.paths['/v1/pedidos'].post.parameters.some((p: { name: string }) => p.name === 'idempotency-key')).toBe(true)
    expect(doc.paths['/v1/agendamentos'].post.responses['409']).toBeDefined()
    expect(doc.components.schemas.Erro).toBeDefined()
  })
})
