import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto'

/**
 * Hash de senha com scrypt (node:crypto), sem dependência nativa.
 * Formato: scrypt$N$r$p$sal$hash (sal e hash em base64url). Os parâmetros ficam
 * no próprio hash, então dá para aumentar o custo no futuro sem invalidar
 * senhas antigas.
 */

const N = 2 ** 15
const R = 8
const P = 1
const TAMANHO = 32

function scrypt(senha: string, sal: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  const opcoes: ScryptOptions = { N: n, r, p, maxmem: 128 * n * r * 2 }
  return new Promise((resolve, reject) => {
    scryptCb(senha.normalize('NFKC'), sal, TAMANHO, opcoes, (err, chave) => (err ? reject(err) : resolve(chave)))
  })
}

export async function gerarHash(senha: string): Promise<string> {
  const sal = randomBytes(16)
  const hash = await scrypt(senha, sal, N, R, P)
  return `scrypt$${N}$${R}$${P}$${sal.toString('base64url')}$${hash.toString('base64url')}`
}

export async function verificarSenha(senha: string, armazenado: string): Promise<boolean> {
  const partes = armazenado.split('$')
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false
  const [, n, r, p, salB64, hashB64] = partes
  const esperado = Buffer.from(hashB64!, 'base64url')
  const calculado = await scrypt(senha, Buffer.from(salB64!, 'base64url'), Number(n), Number(r), Number(p))
  return esperado.length === calculado.length && timingSafeEqual(esperado, calculado)
}

// Hash de uma senha qualquer, usado quando o e-mail não existe: o login gasta o
// mesmo tempo nos dois casos e não revela quais e-mails estão cadastrados.
let hashFicticio: Promise<string> | null = null
export function hashParaComparacaoCega(): Promise<string> {
  hashFicticio ??= gerarHash(randomBytes(12).toString('hex'))
  return hashFicticio
}
