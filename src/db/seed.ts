import type pg from 'pg'
import { gerarHash } from '../auth/senha.js'

/**
 * Dados de demonstração: três negócios fictícios do Recife, com equipe,
 * clientes, serviços, agenda da semana e pedidos. Tudo inventado.
 *
 * Roda com o usuário administrador (superusuário), que passa pelo RLS. Os ids
 * das empresas são fixos para que testes e documentação possam citá-los.
 */

export const SENHA_DEMO = 'balcao123'

export const EMPRESAS_DEMO = {
  clinica: '0b0a1c11-0000-4000-8000-000000000001',
  salao: '0b0a1c11-0000-4000-8000-000000000002',
  restaurante: '0b0a1c11-0000-4000-8000-000000000003',
} as const

interface EmpresaSeed {
  id: string
  slug: string
  nome: string
  segmento: 'clinica' | 'salao' | 'restaurante'
  webhook: 'demo' | 'fora_do_ar' | null
  usuarios: { nome: string; email: string; papel: 'dono' | 'atendente' }[]
  profissionais: { nome: string; especialidade: string }[]
  servicos: { nome: string; duracao: number; preco: number }[]
  /** Horários do dia (HH:MM) e índice do serviço, por profissional. */
  gradeDoDia: [string, number][][]
  produtos: { descricao: string; preco: number }[]
}

const EMPRESAS: EmpresaSeed[] = [
  {
    id: EMPRESAS_DEMO.clinica,
    slug: 'clinica-boa-vista',
    nome: 'Clínica Boa Vista',
    segmento: 'clinica',
    webhook: 'demo',
    usuarios: [
      { nome: 'Ana Beatriz Lopes', email: 'dono@boavista.demo', papel: 'dono' },
      { nome: 'Carla Mendes', email: 'recepcao@boavista.demo', papel: 'atendente' },
    ],
    profissionais: [
      { nome: 'Dra. Helena Cavalcanti', especialidade: 'Dermatologia' },
      { nome: 'Dr. Rafael Moura', especialidade: 'Fisioterapia' },
      { nome: 'Larissa Andrade', especialidade: 'Nutrição' },
    ],
    servicos: [
      { nome: 'Consulta dermatológica', duracao: 30, preco: 25000 },
      { nome: 'Sessão de fisioterapia', duracao: 50, preco: 14000 },
      { nome: 'Avaliação nutricional', duracao: 45, preco: 18000 },
      { nome: 'Limpeza de pele', duracao: 60, preco: 16000 },
    ],
    gradeDoDia: [
      [['08:00', 0], ['08:30', 0], ['10:00', 3], ['14:00', 0], ['16:30', 0]],
      [['07:30', 1], ['09:00', 1], ['11:00', 1], ['15:00', 1]],
      [['09:00', 2], ['13:30', 2], ['16:00', 2]],
    ],
    produtos: [],
  },
  {
    id: EMPRESAS_DEMO.salao,
    slug: 'salao-mare-alta',
    nome: 'Salão Maré Alta',
    segmento: 'salao',
    webhook: null,
    usuarios: [
      { nome: 'Joana Ferraz', email: 'dono@marealta.demo', papel: 'dono' },
      { nome: 'Paulo Sérgio Nunes', email: 'recepcao@marealta.demo', papel: 'atendente' },
    ],
    profissionais: [
      { nome: 'Joana Ferraz', especialidade: 'Cabelo' },
      { nome: 'Bruno Lacerda', especialidade: 'Barbearia' },
      { nome: 'Camila Torres', especialidade: 'Unhas' },
    ],
    servicos: [
      { nome: 'Corte feminino', duracao: 60, preco: 9000 },
      { nome: 'Corte masculino', duracao: 30, preco: 4500 },
      { nome: 'Barba', duracao: 20, preco: 3000 },
      { nome: 'Manicure', duracao: 40, preco: 3500 },
      { nome: 'Escova', duracao: 45, preco: 6000 },
    ],
    gradeDoDia: [
      [['09:00', 0], ['10:30', 4], ['14:00', 0], ['16:00', 4]],
      [['09:00', 1], ['09:30', 2], ['10:00', 1], ['11:00', 1], ['15:00', 2]],
      [['10:00', 3], ['11:00', 3], ['14:30', 3]],
    ],
    produtos: [
      { descricao: 'Máscara de hidratação 250 g', preco: 4890 },
      { descricao: 'Óleo para barba 30 ml', preco: 3200 },
    ],
  },
  {
    id: EMPRESAS_DEMO.restaurante,
    slug: 'sabor-do-capibaribe',
    nome: 'Sabor do Capibaribe',
    segmento: 'restaurante',
    webhook: 'fora_do_ar',
    usuarios: [
      { nome: 'Severino Cunha', email: 'dono@capibaribe.demo', papel: 'dono' },
      { nome: 'Tainá Rocha', email: 'caixa@capibaribe.demo', papel: 'atendente' },
    ],
    profissionais: [
      { nome: 'Mesa 1 · varanda', especialidade: 'até 4 pessoas' },
      { nome: 'Mesa 2 · varanda', especialidade: 'até 4 pessoas' },
      { nome: 'Mesa 3 · salão', especialidade: 'até 8 pessoas' },
    ],
    servicos: [
      { nome: 'Reserva de mesa', duracao: 120, preco: 0 },
      { nome: 'Reserva com menu degustação', duracao: 150, preco: 18900 },
    ],
    gradeDoDia: [
      [['12:00', 0], ['19:00', 0]],
      [['12:30', 1], ['20:00', 0]],
      [['11:30', 0], ['19:30', 1]],
    ],
    produtos: [
      { descricao: 'Baião de dois', preco: 4200 },
      { descricao: 'Carne de sol com macaxeira', preco: 5800 },
      { descricao: 'Tapioca de queijo coalho', preco: 1600 },
      { descricao: 'Bolo de rolo (fatia)', preco: 1400 },
      { descricao: 'Cartola', preco: 2200 },
      { descricao: 'Suco de cajá', preco: 900 },
    ],
  },
]

const NOMES_CLIENTES = [
  'Marina Albuquerque', 'Thiago Barreto', 'Luana Siqueira', 'Pedro Henrique Lins', 'Beatriz Wanderley',
  'Caio Pessoa', 'Renata Maciel', 'Fernanda Tavares', 'Diego Carneiro', 'Juliana Monteiro',
  'Rodrigo Farias', 'Patrícia Queiroz', 'Lucas Arruda', 'Mariana Bezerra', 'Felipe Cordeiro',
  'Aline Vasconcelos', 'Matheus Galvão', 'Isabela Coutinho', 'Vinícius Holanda', 'Camila Freire',
  'André Pontes', 'Letícia Moraes', 'Eduardo Leal', 'Gabriela Melo', 'Sofia Barros',
]

export interface OpcoesSeed {
  /** Dia de referência (AAAA-MM-DD) no fuso do Recife. Padrão: hoje. */
  hoje?: string
  urlWebhookDemo?: string
}

export function hojeNoRecife(agora = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Recife' }).format(agora)
}

export async function semear(admin: pg.ClientBase, opcoes: OpcoesSeed = {}): Promise<{ empresas: number }> {
  const hoje = opcoes.hoje ?? hojeNoRecife()
  const urlDemo = opcoes.urlWebhookDemo ?? 'http://localhost:4280/demo/webhooks'
  const hash = await gerarHash(SENHA_DEMO)

  await admin.query('begin')
  try {
    for (const [ei, e] of EMPRESAS.entries()) {
      const webhookUrl =
        e.webhook === 'demo' ? `${urlDemo}/${e.slug}` :
        e.webhook === 'fora_do_ar' ? 'http://webhook.sabor-do-capibaribe.invalid/eventos' : null
      await admin.query(
        `insert into tenants (id, slug, nome, segmento, webhook_url, webhook_segredo)
         values ($1, $2, $3, $4, $5, $6)`,
        [e.id, e.slug, e.nome, e.segmento, webhookUrl, webhookUrl ? `whsec_demo_${e.slug.replace(/-/g, '_')}_2026` : null],
      )
      for (const u of e.usuarios) {
        await admin.query(
          'insert into usuarios (tenant_id, nome, email, senha_hash, papel) values ($1, $2, $3, $4, $5)',
          [e.id, u.nome, u.email, hash, u.papel],
        )
      }
      const profIds: string[] = []
      for (const p of e.profissionais) {
        const { rows } = await admin.query<{ id: string }>(
          'insert into profissionais (tenant_id, nome, especialidade) values ($1, $2, $3) returning id',
          [e.id, p.nome, p.especialidade],
        )
        profIds.push(rows[0]!.id)
      }
      const servIds: string[] = []
      for (const s of e.servicos) {
        const { rows } = await admin.query<{ id: string }>(
          'insert into servicos (tenant_id, nome, duracao_min, preco_centavos) values ($1, $2, $3, $4) returning id',
          [e.id, s.nome, s.duracao, s.preco],
        )
        servIds.push(rows[0]!.id)
      }
      const cliIds: string[] = []
      const deslocamento = ei * 8
      for (let i = 0; i < 18; i++) {
        const nome = NOMES_CLIENTES[(i + deslocamento) % NOMES_CLIENTES.length]!
        const telefone = `+55819${String(81000000 + ei * 100000 + i * 7919).padStart(8, '0')}`
        const email = i % 3 === 0 ? `${nome.split(' ')[0]!.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')}@exemplo.com.br` : null
        const { rows } = await admin.query<{ id: string }>(
          'insert into clientes (tenant_id, nome, telefone, email) values ($1, $2, $3, $4) returning id',
          [e.id, nome, telefone, email],
        )
        cliIds.push(rows[0]!.id)
      }

      // Agenda: a mesma grade de horários de ontem até daqui a 5 dias, variando
      // o cliente. Ontem fica concluído, com uma falta.
      let k = 0
      for (let dia = -1; dia <= 5; dia++) {
        for (const [pi, grade] of e.gradeDoDia.entries()) {
          for (const [gi, [hora, si]] of grade.entries()) {
            if (dia > 0 && (gi + dia + pi) % 3 === 0) continue // dias seguintes menos cheios
            const status = dia < 0 ? (k % 7 === 3 ? 'faltou' : 'concluido') : (gi % 2 === 0 ? 'confirmado' : 'agendado')
            const servico = e.servicos[si]!
            await admin.query(
              `insert into agendamentos (tenant_id, profissional_id, cliente_id, servico_id, periodo, status, preco_centavos)
               select $1, $2, $3, $4,
                      tstzrange(t, t + make_interval(mins => $5), '[)'), $6, $7
                 from (select (($8::date + $9::int) + $10::time) at time zone 'America/Recife' as t) x`,
              [e.id, profIds[pi], cliIds[k % cliIds.length], servIds[si], servico.duracao, status, servico.preco, hoje, dia, hora],
            )
            k++
          }
        }
      }

      // Pedidos do dia, cada um com 1 a 3 itens. O total é calculado pelo gatilho.
      if (e.produtos.length > 0) {
        const quantos = e.segmento === 'restaurante' ? 7 : 2
        for (let i = 0; i < quantos; i++) {
          const { rows } = await admin.query<{ id: string }>(
            `insert into pedidos (tenant_id, cliente_id, status, criado_em)
             values ($1, $2, $3, (($4::date) + time '11:40' + make_interval(mins => $5)) at time zone 'America/Recife')
             returning id`,
            [e.id, i % 2 === 0 ? cliIds[(i * 5) % cliIds.length] : null, i < quantos - 2 ? 'pago' : 'aberto', hoje, i * 23],
          )
          const itens = e.produtos.filter((_, pi) => (pi + i) % 3 !== 2).slice(0, 1 + (i % 3))
          for (const [ii, p] of itens.entries()) {
            await admin.query(
              `insert into itens_pedido (tenant_id, pedido_id, descricao, quantidade, preco_unitario_centavos)
               values ($1, $2, $3, $4, $5)`,
              [e.id, rows[0]!.id, p.descricao, 1 + ((i + ii) % 2), p.preco],
            )
          }
        }
      }
    }

    // Um pouco de histórico na fila, para o painel não começar vazio: lembretes
    // de ontem já enviados e um webhook do restaurante que esgotou as tentativas.
    await admin.query(
      `with base as (
         select a.tenant_id, a.id as agendamento_id, c.telefone, c.nome as cliente, row_number() over (partition by a.tenant_id order by lower(a.periodo)) as n,
                lower(a.periodo) as inicio
           from agendamentos a join clientes c on c.tenant_id = a.tenant_id and c.id = a.cliente_id
          where a.status = 'concluido' and a.tenant_id = $1
       ), novos as (
         insert into jobs (tenant_id, tipo, payload, status, tentativas, executar_em, criado_em, concluido_em, chave_idempotencia, resultado)
         select tenant_id, 'lembrete_agendamento', jsonb_build_object('agendamento_id', agendamento_id), 'concluido', 1,
                inicio - interval '24 hours', inicio - interval '25 hours', inicio - interval '24 hours',
                'lembrete:' || agendamento_id, 'enviado'
           from base where n <= 3
         returning id, tenant_id, payload, concluido_em
       )
       insert into outbox (tenant_id, canal, destino, conteudo, job_id, chave, criado_em)
       select n.tenant_id, 'whatsapp', b.telefone,
              jsonb_build_object('texto', 'Olá, ' || split_part(b.cliente, ' ', 1) || '! Lembrete do seu horário de amanhã na Clínica Boa Vista.'),
              n.id, 'lembrete:' || b.agendamento_id, n.concluido_em
         from novos n join base b on b.agendamento_id = (n.payload ->> 'agendamento_id')::uuid`,
      [EMPRESAS_DEMO.clinica],
    )
    await admin.query(
      `insert into jobs (tenant_id, tipo, payload, status, tentativas, max_tentativas, executar_em, criado_em, ultimo_erro, chave_idempotencia)
       values ($1, 'entrega_webhook',
               jsonb_build_object('evento', 'pedido.criado', 'dados', jsonb_build_object('pedido_id', (select id from pedidos where tenant_id = $1 order by criado_em limit 1))),
               'morto', 5, 5, now() - interval '20 minutes', now() - interval '52 minutes',
               'getaddrinfo ENOTFOUND webhook.sabor-do-capibaribe.invalid', 'seed:webhook-morto')`,
      [EMPRESAS_DEMO.restaurante],
    )
    await admin.query('commit')
  } catch (err) {
    await admin.query('rollback')
    throw err
  }
  return { empresas: EMPRESAS.length }
}

/**
 * Volume para EXPLAIN e teste de carga: N empresas sintéticas ("carga-001"...),
 * cada uma com clientes, 5 profissionais e agendamentos de hora em hora num
 * intervalo de dias em volta de hoje. Usa generate_series no próprio banco e
 * desliga gatilhos (session_replication_role) só durante a carga em massa.
 */
export async function semearCarga(
  admin: pg.ClientBase,
  opcoes: { empresas?: number; clientesPorEmpresa?: number; dias?: number; hoje?: string } = {},
): Promise<{ empresas: number; clientes: number; agendamentos: number }> {
  const empresas = opcoes.empresas ?? 50
  const clientes = opcoes.clientesPorEmpresa ?? 2000
  const dias = opcoes.dias ?? 80
  const hoje = opcoes.hoje ?? hojeNoRecife()
  const hash = await gerarHash(SENHA_DEMO)

  await admin.query('begin')
  try {
    await admin.query(`set local session_replication_role = replica`)
    await admin.query(
      `insert into tenants (slug, nome, segmento)
       select 'carga-' || lpad(g::text, 3, '0'), 'Empresa de carga ' || g,
              (array['clinica','salao','restaurante'])[1 + g % 3]
         from generate_series(1, $1) g
       on conflict (slug) do nothing`,
      [empresas],
    )
    await admin.query(
      `insert into usuarios (tenant_id, nome, email, senha_hash, papel)
       select t.id, 'Dono ' || t.slug, 'dono@' || t.slug || '.demo', $1, 'dono'
         from tenants t where t.slug like 'carga-%'
       on conflict do nothing`,
      [hash],
    )
    await admin.query(
      `insert into profissionais (tenant_id, nome, especialidade)
       select t.id, 'Profissional ' || p, 'Geral'
         from tenants t cross join generate_series(1, 5) p
        where t.slug like 'carga-%'
          and not exists (select 1 from profissionais x where x.tenant_id = t.id)`,
    )
    await admin.query(
      `insert into servicos (tenant_id, nome, duracao_min, preco_centavos)
       select t.id, 'Atendimento padrão', 50, 12000
         from tenants t where t.slug like 'carga-%'
       on conflict do nothing`,
    )
    await admin.query(
      `insert into clientes (tenant_id, nome, telefone)
       select t.id,
              (array['Ana','Bruno','Carla','Davi','Elisa','Fábio','Gil','Helena','Ícaro','Júlia'])[1 + c % 10] || ' ' ||
              (array['Souza','Lima','Araújo','Cavalcanti','Barros','Melo','Freitas','Rocha'])[1 + (c / 10) % 8] || ' ' || c,
              '+55819' || lpad((10000000 + row_number() over (partition by t.id order by c))::text, 8, '0')
         from tenants t cross join generate_series(1, $1) c
        where t.slug like 'carga-%'
       on conflict do nothing`,
      [clientes],
    )
    // Agendamentos de hora em hora, das 8h às 17h, de (hoje - dias + 20) a hoje + 19.
    await admin.query(
      `with prof as (
         select p.tenant_id, p.id, row_number() over (partition by p.tenant_id order by p.id) as n
           from profissionais p join tenants t on t.id = p.tenant_id where t.slug like 'carga-%'
       ), cli as (
         select tenant_id, array_agg(id) as ids from clientes
          where tenant_id in (select id from tenants where slug like 'carga-%') group by tenant_id
       ), serv as (
         select tenant_id, id from servicos where tenant_id in (select id from tenants where slug like 'carga-%')
       )
       insert into agendamentos (tenant_id, profissional_id, cliente_id, servico_id, periodo, status, preco_centavos)
       select prof.tenant_id, prof.id,
              cli.ids[1 + ((d * 10 + h + prof.n * 7) % array_length(cli.ids, 1))],
              serv.id,
              tstzrange(t, t + interval '50 minutes', '[)'),
              case when d < $1 - 20 then 'concluido' else 'agendado' end,
              12000
         from prof
         join cli using (tenant_id)
         join serv using (tenant_id)
         cross join generate_series(0, $1 - 1) d
         cross join generate_series(8, 17) h
         cross join lateral (select (($2::date - ($1 - 20) + d) + make_interval(hours => h)) at time zone 'America/Recife' as t) x
        where not exists (select 1 from agendamentos a where a.tenant_id = prof.tenant_id limit 1)`,
      [dias, hoje],
    )
    await admin.query('commit')
  } catch (err) {
    await admin.query('rollback')
    throw err
  }
  await admin.query('analyze')
  const { rows } = await admin.query<{ clientes: number; agendamentos: number }>(
    `select (select count(*) from clientes) as clientes, (select count(*) from agendamentos) as agendamentos`,
  )
  return { empresas, clientes: rows[0]!.clientes, agendamentos: rows[0]!.agendamentos }
}
