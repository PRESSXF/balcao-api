import '@fontsource-variable/ibm-plex-sans'
import '@fontsource/ibm-plex-mono/400.css'
import './style.css'
import { atual, chamar, entrar, sair, type ErroApi } from './api'

// ----------------------------------------------------------------- tipos da API

interface Profissional { id: string; nome: string; especialidade: string }
interface Servico { id: string; nome: string; duracao_min: number; preco_centavos: number; ativo: boolean }
interface Cliente { id: string; nome: string; telefone: string }
interface Agendamento {
  id: string; profissional_id: string; profissional: string; cliente: string; servico: string
  inicio: string; fim: string; status: string; preco_centavos: number
}
interface Agenda { dia: string; fuso: string; profissionais: Profissional[]; agendamentos: Agendamento[] }
interface Job {
  id: number; tipo: 'lembrete_agendamento' | 'entrega_webhook'; status: 'pendente' | 'executando' | 'concluido' | 'morto'
  evento: string | null; tentativas: number; max_tentativas: number; executar_em: string; criado_em: string
  concluido_em: string | null; ultimo_erro: string | null; resultado: string | null
}
interface Fila { resumo: Record<Job['status'], number>; jobs: Job[] }
interface Mensagem { id: number; canal: 'whatsapp' | 'webhook'; destino: string; texto: string | null; status_http: number | null; job_id: number | null; criado_em: string }
interface Registro { id: number; tabela: string; registro_id: string | null; acao: 'INSERT' | 'UPDATE' | 'DELETE'; usuario: string | null; requisicao: string | null; antes: Record<string, unknown> | null; depois: Record<string, unknown> | null; em: string }
interface ContasDemo { senha: string; empresas: { slug: string; nome: string; segmento: string; usuarios: { email: string; papel: string; nome: string }[] }[] }

// ----------------------------------------------------------------- utilidades

const app = document.querySelector<HTMLDivElement>('#app')!
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const reais = (c: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(c / 100)
const SEGMENTOS: Record<string, string> = { clinica: 'Clínica', salao: 'Salão de beleza', restaurante: 'Restaurante' }
const TIPOS: Record<Job['tipo'], string> = { lembrete_agendamento: 'Lembrete por WhatsApp', entrega_webhook: 'Webhook' }
const ESTADOS: Record<Job['status'], string> = { pendente: 'Na fila', executando: 'Executando', concluido: 'Concluído', morto: 'Esgotou as tentativas' }
const TABELAS: Record<string, string> = { agendamentos: 'Agendamento', clientes: 'Cliente', pedidos: 'Pedido', servicos: 'Serviço', profissionais: 'Profissional', usuarios: 'Usuário' }

function hojeNo(fuso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: fuso }).format(new Date())
}
function somarDias(dia: string, n: number): string {
  const d = new Date(`${dia}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function deslocamento(fuso: string, dia: string): string {
  const nome = new Intl.DateTimeFormat('en-US', { timeZone: fuso, timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${dia}T12:00:00Z`)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
  return nome === 'GMT' ? '+00:00' : nome.replace('GMT', '')
}
function minutosNoDia(iso: string, fuso: string): number {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: fuso, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso))
  return Number(p.find((x) => x.type === 'hour')!.value) * 60 + Number(p.find((x) => x.type === 'minute')!.value)
}
const hora = (iso: string, fuso: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
const diaLongo = (dia: string) => new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' }).format(new Date(`${dia}T12:00:00Z`))
function relativo(iso: string): string {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000)
  const abs = Math.abs(s)
  const txt = abs < 60 ? `${abs} s` : abs < 3600 ? `${Math.round(abs / 60)} min` : abs < 86400 ? `${Math.round(abs / 3600)} h` : `${Math.round(abs / 86400)} d`
  return s > 1 ? `em ${txt}` : `há ${txt}`
}

const MARCA = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#26313e"/><path d="M7 21h18v3H7z" fill="#E0A100"/><path d="M9 8h6v11H9zM17 12h6v7h-6z" fill="#EEF1F4"/></svg>`
const RODAPE = `<p class="rodape">Empresas, pessoas e telefones são fictícios. Feito por João Guilherme Gomes de Araújo · <a href="/docs">Documentação da API</a></p>`

// ----------------------------------------------------------------- entrada

async function telaEntrada(aviso = ''): Promise<void> {
  pararAtualizacao()
  app.innerHTML = `<div class="entrada"><section><div class="marca" style="color:var(--tinta)">${MARCA} Balcão</div>
    <h1>Back-end de agenda e pedidos para pequenos negócios</h1>
    <p>Cada empresa só enxerga os próprios dados: o PostgreSQL filtra todas as consultas pela empresa do login, com Row Level Security.</p>
    <p>Entre como dono ou atendente de um dos três negócios fictícios do Recife.</p>
    <div class="senha" id="senha">Carregando contas…</div>
    ${aviso ? `<p role="alert" style="color:var(--erro);margin-top:14px">${esc(aviso)}</p>` : ''}
    </section><section class="empresas" id="empresas" aria-label="Empresas de demonstração"></section></div>${RODAPE}`
  try {
    const r = await fetch('/demo/contas')
    if (!r.ok) throw new Error()
    const contas = (await r.json()) as ContasDemo
    document.querySelector('#senha')!.innerHTML = `Senha de todas as contas: <b class="mono">${esc(contas.senha)}</b>`
    document.querySelector('#empresas')!.innerHTML = contas.empresas.map((e) => `
      <article class="empresa-card"><h2>${esc(e.nome)}</h2><span class="seg">${esc(SEGMENTOS[e.segmento] ?? e.segmento)} · <span class="mono">${esc(e.slug)}</span></span>
      <div class="contas">${e.usuarios.map((u) => `
        <button class="conta" data-empresa="${esc(e.slug)}" data-email="${esc(u.email)}" data-senha="${esc(contas.senha)}">
          <span class="papel ${esc(u.papel)}">${esc(u.papel)}</span><strong>${esc(u.nome)}</strong><span class="mono">${esc(u.email)}</span>
        </button>`).join('')}</div></article>`).join('')
    document.querySelectorAll<HTMLButtonElement>('.conta').forEach((b) =>
      b.addEventListener('click', async () => {
        b.disabled = true
        try {
          await entrar(b.dataset.empresa!, b.dataset.email!, b.dataset.senha!)
          await telaConsole()
        } catch (e) {
          await telaEntrada((e as ErroApi).mensagem ?? 'Não foi possível entrar.')
        }
      }),
    )
  } catch {
    document.querySelector('#senha')!.textContent = 'As contas de demonstração não estão disponíveis (DEMO_MODE desligado). Use a API pela documentação em /docs.'
  }
}

// ----------------------------------------------------------------- console

const estado = {
  dia: '',
  agenda: null as Agenda | null,
  servicos: [] as Servico[],
  clientes: [] as Cliente[],
  destaque: '' as string,
  jobsVistos: new Set<number>(),
  primeiraFila: true,
}
let temporizadores: number[] = []
function pararAtualizacao() {
  temporizadores.forEach((t) => clearInterval(t))
  temporizadores = []
}

async function telaConsole(): Promise<void> {
  const s = atual()
  if (!s) return telaEntrada()
  pararAtualizacao()
  estado.dia = hojeNo(s.empresa.fuso)
  estado.jobsVistos = new Set()
  estado.primeiraFila = true
  const dono = s.usuario.papel === 'dono'
  app.innerHTML = `
    <header class="topo">
      <div class="marca">${MARCA} Balcão</div>
      <span class="empresa">${esc(s.empresa.nome)}</span>
      <div class="contexto">
        <span class="chip"><span class="ponto" id="ponto-banco"></span>PostgreSQL 16 <b id="migracao"></b></span>
        <span class="chip" title="Valor de app.tenant_id definido em cada transação desta sessão">RLS <b class="mono">app.tenant_id = ${esc(s.empresa.id.slice(0, 8))}…</b></span>
        <span class="chip">${esc(s.usuario.nome)} <b>${esc(s.usuario.papel)}</b></span>
        <a class="chip" href="/docs" style="text-decoration:none">API /docs</a>
        <button class="botao-fantasma" id="sair">Trocar de conta</button>
      </div>
    </header>
    <main>
      <div class="linha-1">
        <section class="painel" aria-labelledby="t-agenda">
          <header><h2 id="t-agenda">Agenda</h2><span class="nota" id="fuso"></span>
            <div class="acoes dia-nav">
              <button class="botao" id="dia-ant" aria-label="Dia anterior">‹</button>
              <span class="dia-rotulo" id="dia-rotulo" aria-live="polite"></span>
              <button class="botao" id="dia-prox" aria-label="Próximo dia">›</button>
              <button class="botao" id="dia-hoje">Hoje</button>
            </div></header>
          <div class="agenda-rolagem" id="agenda-rolagem"><div class="vazio">Carregando agenda…</div></div>
        </section>
        <section class="painel" aria-labelledby="t-novo">
          <header><h2 id="t-novo">Novo agendamento</h2></header>
          <form class="corpo" id="form-ag" novalidate>
            <div class="campo"><label for="f-prof">Profissional</label><select id="f-prof" required></select></div>
            <div class="campo"><label for="f-serv">Serviço</label><select id="f-serv" required></select></div>
            <div class="campo"><label for="f-cli">Cliente</label><select id="f-cli" required></select></div>
            <div class="dupla">
              <div class="campo"><label for="f-dia">Dia</label><select id="f-dia" required></select></div>
              <div class="campo"><label for="f-hora">Início</label><select id="f-hora" required></select></div>
            </div>
            <button class="botao-primario" type="submit" id="f-enviar">Agendar</button>
            <div id="resposta" aria-live="polite"></div>
          </form>
        </section>
      </div>
      <section class="painel" aria-labelledby="t-fila">
        <header><h2 id="t-fila">Fila de jobs</h2><span class="nota">Lembretes e webhooks desta empresa, processados pelo worker</span>
          <div class="acoes contagens" id="contagens"></div></header>
        <div class="trilho" id="trilho"><div class="vazio">Carregando fila…</div></div>
      </section>
      <div class="linha-3">
        <section class="painel" aria-labelledby="t-msg">
          <header><h2 id="t-msg">Mensagens enviadas</h2><span class="nota">WhatsApp simulado e webhooks entregues</span></header>
          <ul class="mensagens" id="mensagens"><li class="vazio">Carregando…</li></ul>
        </section>
        <section class="painel" aria-labelledby="t-aud">
          <header><h2 id="t-aud">Auditoria</h2><span class="nota">Gravada por gatilhos no banco</span></header>
          <ul class="auditoria" id="auditoria">${dono ? '<li class="vazio">Carregando…</li>' : '<li class="vazio">Só o dono vê a auditoria. Entre com a conta de dono para ver quem mudou o quê.</li>'}</ul>
        </section>
      </div>
    </main>${RODAPE}`

  document.querySelector('#sair')!.addEventListener('click', async () => {
    await sair()
    await telaEntrada()
  })
  document.querySelector('#dia-ant')!.addEventListener('click', () => mudarDia(-1))
  document.querySelector('#dia-prox')!.addEventListener('click', () => mudarDia(1))
  document.querySelector('#dia-hoje')!.addEventListener('click', () => mudarDia(0))
  document.querySelector('#form-ag')!.addEventListener('submit', enviarAgendamento)
  document.querySelector('#f-prof')!.addEventListener('change', sugerirHorario)
  document.querySelector('#f-serv')!.addEventListener('change', sugerirHorario)
  preencherSelect('#f-hora', Array.from({ length: (22 - 6) * 4 + 1 }, (_, i) => {
    const m = 6 * 60 + i * 15
    const v = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
    return [v, v]
  }))

  try {
    const [servicos, clientes] = await Promise.all([
      chamar<Servico[]>('GET', '/v1/servicos'),
      chamar<{ itens: Cliente[] }>('GET', '/v1/clientes?limite=100'),
    ])
    estado.servicos = servicos.dados.filter((x) => x.ativo)
    estado.clientes = clientes.dados.itens
    preencherSelect('#f-serv', estado.servicos.map((x) => [x.id, `${x.nome} · ${x.duracao_min} min · ${reais(x.preco_centavos)}`]))
    preencherSelect('#f-cli', estado.clientes.map((x) => [x.id, x.nome]))
    await carregarAgenda()
    await Promise.all([atualizarFila(), atualizarMensagens(), dono ? atualizarAuditoria() : null, atualizarProntidao()])
  } catch (e) {
    return tratarErroSessao(e)
  }

  const vivo = (fn: () => Promise<unknown>, ms: number) =>
    temporizadores.push(window.setInterval(() => { if (!document.hidden) fn().catch(tratarErroSessao) }, ms))
  vivo(atualizarFila, 1000)
  vivo(atualizarMensagens, 1500)
  if (dono) vivo(atualizarAuditoria, 2000)
  vivo(() => carregarAgenda(false), 6000)
  vivo(atualizarProntidao, 10000)
}

function tratarErroSessao(e: unknown) {
  const err = e as ErroApi
  if (err?.status === 401) return telaEntrada('Sua sessão terminou. Entre de novo.')
  console.error(e)
}

function preencherSelect(sel: string, opcoes: [string, string][]) {
  const el = document.querySelector<HTMLSelectElement>(sel)!
  const atualValor = el.value
  el.innerHTML = opcoes.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('')
  if (opcoes.some(([v]) => v === atualValor)) el.value = atualValor
}

async function atualizarProntidao() {
  const r = await fetch('/ready').then((x) => x.json() as Promise<{ status: string; migracao?: string }>).catch(() => null)
  const ponto = document.querySelector<HTMLElement>('#ponto-banco')
  if (ponto) ponto.style.background = r?.status === 'pronto' ? '#52c48a' : '#e0564b'
  const m = document.querySelector('#migracao')
  if (m) m.textContent = r?.migracao ? `migração ${r.migracao}` : 'indisponível'
}

async function mudarDia(n: number) {
  const s = atual()!
  estado.dia = n === 0 ? hojeNo(s.empresa.fuso) : somarDias(estado.dia, n)
  await carregarAgenda().catch(tratarErroSessao)
}

// ----------------------------------------------------------------- agenda

async function carregarAgenda(sugerir = true) {
  const r = await chamar<Agenda>('GET', `/v1/agenda?dia=${estado.dia}`)
  estado.agenda = r.dados
  const profsAntes = document.querySelector<HTMLSelectElement>('#f-prof')!.options.length
  preencherSelect('#f-prof', r.dados.profissionais.map((p) => [p.id, `${p.nome} (${p.especialidade})`]))
  desenharAgenda()
  if (sugerir || profsAntes === 0) {
    preencherSelect('#f-dia', Array.from({ length: 22 }, (_, i) => {
      const d = somarDias(estado.dia, i - 7)
      return [d, diaLongo(d)]
    }))
    document.querySelector<HTMLSelectElement>('#f-dia')!.value = estado.dia
    sugerirHorario()
  }
}

function desenharAgenda() {
  const ag = estado.agenda!
  const fuso = ag.fuso
  document.querySelector('#dia-rotulo')!.textContent = diaLongo(ag.dia)
  document.querySelector('#fuso')!.textContent = fuso
  const inicios = ag.agendamentos.map((a) => minutosNoDia(a.inicio, fuso))
  const fins = ag.agendamentos.map((a) => minutosNoDia(a.fim, fuso) || 24 * 60)
  const de = Math.min(7 * 60, ...inicios.map((m) => Math.floor(m / 60) * 60))
  const ate = Math.max(20 * 60, ...fins.map((m) => Math.ceil(m / 60) * 60))
  const px = 46 / 60
  const altura = (ate - de) * px
  const horas = Array.from({ length: (ate - de) / 60 + 1 }, (_, i) => de / 60 + i)
  const agoraMin = ag.dia === hojeNo(fuso) ? minutosNoDia(new Date().toISOString(), fuso) : -1

  const colunas = ag.profissionais.map((p) => {
    const blocos = ag.agendamentos.filter((a) => a.profissional_id === p.id).map((a) => {
      const top = (minutosNoDia(a.inicio, fuso) - de) * px
      const h = Math.max(22, ((minutosNoDia(a.fim, fuso) || 24 * 60) - minutosNoDia(a.inicio, fuso)) * px - 2)
      return `<div class="bloco ${esc(a.status)} ${a.id === estado.destaque ? 'novo' : ''}" style="top:${top}px;height:${h}px" title="${esc(`${hora(a.inicio, fuso)}–${hora(a.fim, fuso)} · ${a.cliente} · ${a.servico} · ${a.status}`)}">
        <strong>${esc(hora(a.inicio, fuso))} ${esc(a.cliente)}</strong><span>${esc(a.servico)}</span></div>`
    }).join('')
    const agora = agoraMin >= de && agoraMin <= ate ? `<div class="agora" style="top:${(agoraMin - de) * px}px" aria-hidden="true"></div>` : ''
    return `<div class="coluna" style="height:${altura}px">${blocos}${agora}</div>`
  })
  const el = document.querySelector<HTMLElement>('#agenda-rolagem')!
  if (ag.profissionais.length === 0) {
    el.innerHTML = '<div class="vazio">Nenhum profissional ativo nesta empresa.</div>'
    return
  }
  el.innerHTML = `<div class="agenda" style="--colunas:${ag.profissionais.length}" role="grid" aria-label="Agenda de ${esc(diaLongo(ag.dia))}">
    <div class="cab"></div>${ag.profissionais.map((p) => `<div class="cab"><strong>${esc(p.nome)}</strong><span>${esc(p.especialidade)}</span></div>`).join('')}
    <div class="horas" style="height:${altura}px">${horas.map((h) => `<span style="top:${(h * 60 - de) * px}px">${String(h).padStart(2, '0')}h</span>`).join('')}</div>
    ${colunas.join('')}</div>`
  if (ag.agendamentos.length === 0) el.insertAdjacentHTML('beforeend', '<div class="vazio">Sem agendamentos neste dia. Use o formulário ao lado para criar o primeiro.</div>')
}

/** Primeiro horário livre (de 30 em 30 min, entre 8h e 18h) para o profissional e serviço escolhidos. */
function sugerirHorario() {
  const ag = estado.agenda
  if (!ag) return
  const prof = document.querySelector<HTMLSelectElement>('#f-prof')!.value
  const serv = estado.servicos.find((s) => s.id === document.querySelector<HTMLSelectElement>('#f-serv')!.value)
  const dur = serv?.duracao_min ?? 30
  const ocupados = ag.agendamentos
    .filter((a) => a.profissional_id === prof && (a.status === 'agendado' || a.status === 'confirmado'))
    .map((a) => [minutosNoDia(a.inicio, ag.fuso), minutosNoDia(a.fim, ag.fuso) || 1440] as const)
  const agora = ag.dia === hojeNo(ag.fuso) ? minutosNoDia(new Date().toISOString(), ag.fuso) + 30 : 0
  for (let m = 8 * 60; m + dur <= 18 * 60; m += 30) {
    if (m < agora) continue
    if (ocupados.every(([i, f]) => m + dur <= i || m >= f)) {
      document.querySelector<HTMLSelectElement>('#f-hora')!.value = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
      return
    }
  }
}

async function enviarAgendamento(ev: Event) {
  ev.preventDefault()
  const s = atual()!
  const botao = document.querySelector<HTMLButtonElement>('#f-enviar')!
  const resp = document.querySelector<HTMLElement>('#resposta')!
  const dia = document.querySelector<HTMLSelectElement>('#f-dia')!.value
  const h = document.querySelector<HTMLSelectElement>('#f-hora')!.value
  if (!dia || !h) {
    resp.innerHTML = `<div class="resposta erro"><div class="linha-status">Preencha o dia e o horário de início.</div></div>`
    return
  }
  const corpo = {
    profissional_id: document.querySelector<HTMLSelectElement>('#f-prof')!.value,
    servico_id: document.querySelector<HTMLSelectElement>('#f-serv')!.value,
    cliente_id: document.querySelector<HTMLSelectElement>('#f-cli')!.value,
    inicio: `${dia}T${h}:00${deslocamento(s.empresa.fuso, dia)}`,
  }
  botao.disabled = true
  const t0 = performance.now()
  try {
    const r = await chamar<Agendamento>('POST', '/v1/agendamentos', corpo)
    const ms = Math.round(performance.now() - t0)
    resp.innerHTML = `<div class="resposta ok"><div class="linha-status"><span class="mono">201</span> Agendado</div>
      ${esc(r.dados.cliente)} com ${esc(r.dados.profissional)}, ${esc(hora(r.dados.inicio, s.empresa.fuso))} às ${esc(hora(r.dados.fim, s.empresa.fuso))}.
      <dl><dt>Preço</dt><dd>${esc(reais(r.dados.preco_centavos))}</dd><dt>Fila</dt><dd>lembrete e webhook na mesma transação</dd><dt>Tempo</dt><dd class="mono">${ms} ms</dd></dl></div>`
    estado.destaque = r.dados.id
    if (dia !== estado.dia) estado.dia = dia
    await carregarAgenda(false)
  } catch (e) {
    const err = e as ErroApi
    if (err.status === 401) return tratarErroSessao(e)
    const restricao = err.detalhes?.find((d) => d.restricao)
    const campos = err.detalhes?.filter((d) => d.campo) ?? []
    resp.innerHTML = `<div class="resposta erro" role="alert"><div class="linha-status"><span class="mono">${err.status}</span> ${esc(err.mensagem)}</div>
      <dl><dt>Código</dt><dd class="mono">${esc(err.codigo)}</dd>
      ${restricao ? `<dt>Recusado por</dt><dd class="mono">${esc(restricao.restricao)}</dd><dt>PostgreSQL</dt><dd class="mono">${esc(restricao.mensagem)}</dd>` : ''}
      ${campos.map((c) => `<dt class="mono">${esc(c.campo)}</dt><dd>${esc(c.mensagem)}</dd>`).join('')}
      ${err.requisicao ? `<dt>Requisição</dt><dd class="mono">${esc(err.requisicao)}</dd>` : ''}</dl></div>`
  } finally {
    botao.disabled = false
  }
}

// ----------------------------------------------------------------- fila, mensagens e auditoria

async function atualizarFila() {
  const r = await chamar<Fila>('GET', '/v1/fila?limite=14')
  const { resumo, jobs } = r.dados
  document.querySelector('#contagens')!.innerHTML = (['pendente', 'executando', 'concluido', 'morto'] as const)
    .map((st) => `<span class="contagem ${st}">${esc(ESTADOS[st])} <b>${resumo[st]}</b></span>`).join('')
  const trilho = document.querySelector<HTMLElement>('#trilho')!
  if (jobs.length === 0) {
    trilho.innerHTML = '<div class="vazio">Fila vazia. Crie um agendamento para ver o lembrete e o webhook passarem por aqui.</div>'
    return
  }
  trilho.innerHTML = jobs.map((j) => {
    const novo = !estado.primeiraFila && !estado.jobsVistos.has(j.id)
    estado.jobsVistos.add(j.id)
    const quando = j.status === 'concluido' && j.concluido_em ? `concluído ${relativo(j.concluido_em)}`
      : j.status === 'pendente' ? (new Date(j.executar_em).getTime() > Date.now() + 1500 ? `próxima tentativa ${relativo(j.executar_em)}` : 'aguardando o worker')
      : j.status === 'executando' ? `tentativa ${j.tentativas} de ${j.max_tentativas}` : `criado ${relativo(j.criado_em)}`
    return `<article class="ticket ${j.status} ${novo ? 'recem' : ''}" aria-label="Job ${j.id}: ${esc(ESTADOS[j.status])}">
      <div class="numero">#${j.id}</div>
      <div class="tipo">${esc(TIPOS[j.tipo])}</div>
      <span class="estado"><i></i>${esc(ESTADOS[j.status])}</span>
      <div class="meta">
        ${j.evento ? `<span class="mono">${esc(j.evento)}</span>` : ''}
        <span>${esc(quando)}${j.tentativas > 1 || j.status === 'morto' ? ` · ${j.tentativas}/${j.max_tentativas} tentativas` : ''}</span>
        ${j.status !== 'concluido' && j.ultimo_erro ? `<span class="erro-texto">${esc(j.ultimo_erro.slice(0, 90))}</span>` : ''}
        ${j.status === 'concluido' && j.resultado ? `<span>${esc(j.resultado)}</span>` : ''}
      </div></article>`
  }).join('')
  estado.primeiraFila = false
}

async function atualizarMensagens() {
  const r = await chamar<Mensagem[]>('GET', '/v1/outbox?limite=12')
  const el = document.querySelector<HTMLElement>('#mensagens')!
  if (r.dados.length === 0) {
    el.innerHTML = '<li class="vazio">Nenhuma mensagem ainda. Os lembretes aparecem aqui quando o worker envia.</li>'
    return
  }
  el.innerHTML = r.dados.map((m) => `<li class="msg ${m.canal}">
    <span class="de">${m.canal === 'whatsapp' ? `WhatsApp para <span class="mono">${esc(m.destino)}</span>` : `Webhook <span class="mono">HTTP ${esc(m.status_http)}</span>`}<span>${esc(relativo(m.criado_em))}</span>${m.job_id ? `<span class="mono">job #${m.job_id}</span>` : ''}</span>
    <div class="balao">${esc(m.texto ?? '')}</div></li>`).join('')
}

function valor(k: string, v: unknown, fuso: string): string {
  if (v === null || v === undefined) return 'vazio'
  if (k === 'periodo' && typeof v === 'string') {
    const m = /"?([^",[]+)"?,"?([^",)]+)"?/.exec(v)
    if (m) {
      const iso = (x: string) => new Date(x.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'))
      const [i, f] = [iso(m[1]!), iso(m[2]!)]
      const d = new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, day: '2-digit', month: '2-digit' }).format(i)
      return `${d} ${hora(i.toISOString(), fuso)}–${hora(f.toISOString(), fuso)}`
    }
  }
  if (k.endsWith('_centavos') && typeof v === 'number') return reais(v)
  return typeof v === 'string' ? v : JSON.stringify(v)
}

function resumoMudanca(r: Registro): string {
  const fuso = atual()?.empresa.fuso ?? 'America/Recife'
  const campos = ['nome', 'status', 'total_centavos', 'preco_centavos', 'telefone', 'periodo']
  if (r.acao === 'UPDATE' && r.antes && r.depois) {
    const mudou = Object.keys(r.depois).filter((k) => JSON.stringify(r.antes![k]) !== JSON.stringify(r.depois![k]))
    return mudou.slice(0, 3).map((k) => `${esc(k)}: <del>${esc(valor(k, r.antes![k], fuso))}</del> <ins>${esc(valor(k, r.depois![k], fuso))}</ins>`).join('<br>')
  }
  const linha = r.depois ?? r.antes ?? {}
  return campos.filter((k) => k in linha).slice(0, 3).map((k) => `${esc(k)}: ${esc(valor(k, linha[k], fuso))}`).join('<br>')
}

async function atualizarAuditoria() {
  const r = await chamar<{ itens: Registro[] }>('GET', '/v1/auditoria?limite=12')
  const el = document.querySelector<HTMLElement>('#auditoria')!
  el.innerHTML = r.dados.itens.map((a) => `<li>
    <div class="cab-reg"><span class="acao ${a.acao}">${a.acao}</span><strong>${esc(TABELAS[a.tabela] ?? a.tabela)}</strong>
      <span style="color:var(--tinta-3)">${esc(a.usuario ?? 'sistema')} · ${esc(relativo(a.em))}</span>${a.requisicao ? `<span class="mono" style="color:var(--tinta-3)">${esc(a.requisicao)}</span>` : ''}</div>
    <div class="diff">${resumoMudanca(a)}</div></li>`).join('') || '<li class="vazio">Sem registros.</li>'
}

// ----------------------------------------------------------------- início

if (atual()) void telaConsole()
else void telaEntrada()
