import { isPgError } from '../db/pool.js'

/**
 * Formato único de erro da API:
 *
 *   { "erro": { "codigo": "conflito_horario", "mensagem": "...", "detalhes": [...] }, "requisicao": "req-1" }
 *
 * `codigo` é estável (para o front-end tratar); `mensagem` é em português,
 * pronta para mostrar ao usuário.
 */

export interface DetalheErro {
  campo?: string
  mensagem: string
  restricao?: string
}

export class ErroApi extends Error {
  constructor(
    public statusCode: number,
    public codigo: string,
    mensagem: string,
    public detalhes?: DetalheErro[],
  ) {
    super(mensagem)
  }
}

export const naoEncontrado = (oque: string) => new ErroApi(404, 'nao_encontrado', `${oque} não encontrado.`)

// ---------------------------------------------------------------------------
// Validação (Ajv) em português

interface ErroAjv {
  keyword: string
  instancePath: string
  params: Record<string, unknown>
  message?: string
}

const TIPOS: Record<string, string> = {
  string: 'texto',
  integer: 'número inteiro',
  number: 'número',
  boolean: 'verdadeiro ou falso',
  object: 'objeto',
  array: 'lista',
  null: 'nulo',
}

const FORMATOS: Record<string, string> = {
  'date-time': 'uma data e hora no formato ISO 8601 (ex.: 2026-11-16T14:30:00-03:00)',
  date: 'uma data no formato AAAA-MM-DD',
  uuid: 'um identificador UUID',
  email: 'um e-mail válido',
  uri: 'uma URL válida',
}

const CONTEXTOS: Record<string, string> = {
  body: '',
  querystring: 'query',
  params: 'parametro',
  headers: 'cabecalho',
}

function caminho(contexto: string | undefined, instancePath: string, extra?: string): string {
  const partes = instancePath.split('/').filter(Boolean)
  if (extra) partes.push(extra)
  const prefixo = CONTEXTOS[contexto ?? 'body'] ?? ''
  return [prefixo, ...partes].filter(Boolean).join('.') || '(corpo)'
}

export function traduzirErroValidacao(erro: ErroAjv, contexto?: string): DetalheErro {
  const p = erro.params
  switch (erro.keyword) {
    case 'required':
      return { campo: caminho(contexto, erro.instancePath, String(p.missingProperty)), mensagem: 'é obrigatório' }
    case 'type': {
      const tipos = String(p.type).split(',').map((t) => TIPOS[t] ?? t)
      return { campo: caminho(contexto, erro.instancePath), mensagem: `deve ser ${tipos.join(' ou ')}` }
    }
    case 'minLength':
      return { campo: caminho(contexto, erro.instancePath), mensagem: `deve ter pelo menos ${String(p.limit)} caractere(s)` }
    case 'maxLength':
      return { campo: caminho(contexto, erro.instancePath), mensagem: `deve ter no máximo ${String(p.limit)} caracteres` }
    case 'minimum':
      return { campo: caminho(contexto, erro.instancePath), mensagem: `deve ser no mínimo ${String(p.limit)}` }
    case 'maximum':
      return { campo: caminho(contexto, erro.instancePath), mensagem: `deve ser no máximo ${String(p.limit)}` }
    case 'minItems':
      return { campo: caminho(contexto, erro.instancePath), mensagem: `deve ter pelo menos ${String(p.limit)} item(ns)` }
    case 'maxItems':
      return { campo: caminho(contexto, erro.instancePath), mensagem: `deve ter no máximo ${String(p.limit)} itens` }
    case 'format':
      return {
        campo: caminho(contexto, erro.instancePath),
        mensagem: `deve ser ${FORMATOS[String(p.format)] ?? `no formato ${String(p.format)}`}`,
      }
    case 'enum':
    case 'const': {
      const valores = (p.allowedValues as unknown[] | undefined) ?? [p.allowedValue]
      return { campo: caminho(contexto, erro.instancePath), mensagem: `deve ser um destes valores: ${valores.join(', ')}` }
    }
    case 'pattern':
      return { campo: caminho(contexto, erro.instancePath), mensagem: 'está em um formato inválido' }
    case 'additionalProperties':
      return { campo: caminho(contexto, erro.instancePath, String(p.additionalProperty)), mensagem: 'não é permitido' }
    default:
      return { campo: caminho(contexto, erro.instancePath), mensagem: 'valor inválido' }
  }
}

// ---------------------------------------------------------------------------
// Erros do PostgreSQL viram respostas com significado

const RESTRICOES: Record<string, { status: number; codigo: string; mensagem: string }> = {
  agendamentos_sem_sobreposicao: {
    status: 409,
    codigo: 'conflito_horario',
    mensagem: 'Este profissional já tem um agendamento que se sobrepõe a esse horário.',
  },
  clientes_tenant_id_telefone_key: {
    status: 409,
    codigo: 'telefone_duplicado',
    mensagem: 'Já existe um cliente com esse telefone.',
  },
  servicos_tenant_id_nome_key: {
    status: 409,
    codigo: 'servico_duplicado',
    mensagem: 'Já existe um serviço com esse nome.',
  },
  agendamentos_periodo_valido: {
    status: 422,
    codigo: 'periodo_invalido',
    mensagem: 'O período do agendamento é inválido (máximo de 8 horas).',
  },
}

export function traduzirErroBanco(err: unknown): ErroApi | null {
  if (!isPgError(err)) return null
  const restricao = err.constraint
  const conhecido = restricao ? RESTRICOES[restricao] : undefined
  const detalhes = restricao ? [{ restricao, mensagem: err.message }] : undefined
  if (conhecido) return new ErroApi(conhecido.status, conhecido.codigo, conhecido.mensagem, detalhes)

  switch (err.code) {
    case '23505':
      return new ErroApi(409, 'registro_duplicado', 'Já existe um registro com esses dados.', detalhes)
    case '23503':
      return new ErroApi(422, 'referencia_invalida', 'Algum item referenciado não existe nesta empresa.', detalhes)
    case '23514':
      return new ErroApi(422, 'regra_violada', 'Os dados não respeitam uma regra do cadastro.', detalhes)
    case '23P01':
      return new ErroApi(409, 'conflito', 'Os dados entram em conflito com um registro existente.', detalhes)
    case 'P0001':
      // Exceções levantadas pelos nossos gatilhos já vêm com mensagem em português.
      return new ErroApi(422, err.hint ?? 'regra_violada', err.message)
    case '42501':
      return new ErroApi(403, 'acesso_negado', 'Operação não permitida para esta empresa.')
    case '22P02':
    case '22007':
    case '22008':
      return new ErroApi(400, 'valor_invalido', 'Algum valor enviado tem formato inválido.')
    default:
      return null
  }
}
