/** Cliente HTTP do console: guarda a sessão e renova o token de acesso quando expira. */

export interface Sessao {
  acesso: string
  renovacao: string
  usuario: { id: string; nome: string; email: string; papel: 'dono' | 'atendente' }
  empresa: { id: string; slug: string; nome: string; segmento: string; fuso: string }
}

export interface ErroApi {
  status: number
  codigo: string
  mensagem: string
  detalhes?: { campo?: string; mensagem: string; restricao?: string }[]
  requisicao?: string
}

const CHAVE = 'balcao.sessao'

export function sessaoSalva(): Sessao | null {
  try {
    const s = sessionStorage.getItem(CHAVE)
    return s ? (JSON.parse(s) as Sessao) : null
  } catch {
    return null
  }
}

function salvar(s: Sessao | null): void {
  try {
    if (s) sessionStorage.setItem(CHAVE, JSON.stringify(s))
    else sessionStorage.removeItem(CHAVE)
  } catch {
    // sem sessionStorage: a sessão vive só na memória
  }
}

let sessao: Sessao | null = sessaoSalva()
export const atual = () => sessao

async function bruto(metodo: string, url: string, corpo?: unknown, cabecalhos: Record<string, string> = {}) {
  const r = await fetch(url, {
    method: metodo,
    headers: { ...(corpo !== undefined ? { 'content-type': 'application/json' } : {}), ...cabecalhos },
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  })
  const texto = await r.text()
  const json = texto ? (JSON.parse(texto) as unknown) : null
  return { status: r.status, json, headers: r.headers }
}

function paraErro(status: number, json: unknown): ErroApi {
  const e = (json as { erro?: Omit<ErroApi, 'status'>; requisicao?: string } | null) ?? {}
  return { status, codigo: e.erro?.codigo ?? 'erro', mensagem: e.erro?.mensagem ?? `HTTP ${status}`, detalhes: e.erro?.detalhes, requisicao: e.requisicao }
}

export async function entrar(empresa: string, email: string, senha: string): Promise<Sessao> {
  const r = await bruto('POST', '/v1/auth/login', { empresa, email, senha })
  if (r.status !== 200) throw paraErro(r.status, r.json)
  sessao = r.json as Sessao
  salvar(sessao)
  return sessao
}

export async function sair(): Promise<void> {
  const s = sessao
  sessao = null
  salvar(null)
  if (s) await bruto('POST', '/v1/auth/sair', { renovacao: s.renovacao }).catch(() => {})
}

async function renovar(): Promise<boolean> {
  if (!sessao) return false
  const r = await bruto('POST', '/v1/auth/renovar', { renovacao: sessao.renovacao })
  if (r.status !== 200) {
    sessao = null
    salvar(null)
    return false
  }
  sessao = r.json as Sessao
  salvar(sessao)
  return true
}

export interface Resposta<T> {
  status: number
  dados: T
  headers: Headers
}

export async function chamar<T>(metodo: string, url: string, corpo?: unknown, cabecalhos: Record<string, string> = {}): Promise<Resposta<T>> {
  if (!sessao) throw { status: 401, codigo: 'nao_autenticado', mensagem: 'Faça login.' } satisfies ErroApi
  let r = await bruto(metodo, url, corpo, { ...cabecalhos, authorization: `Bearer ${sessao.acesso}` })
  if (r.status === 401 && (r.json as { erro?: { codigo?: string } })?.erro?.codigo === 'token_expirado' && (await renovar())) {
    r = await bruto(metodo, url, corpo, { ...cabecalhos, authorization: `Bearer ${sessao!.acesso}` })
  }
  if (r.status >= 400) throw paraErro(r.status, r.json)
  return { status: r.status, dados: r.json as T, headers: r.headers }
}
