import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Assinatura dos webhooks enviados, no mesmo espírito do Stripe:
 *
 *   X-Balcao-Assinatura: t=1763060000,v1=<hex do HMAC-SHA256 de "t.corpo">
 *
 * O timestamp entra na assinatura para o receptor recusar reenvios antigos
 * (ataque de repetição). O receptor recalcula com o segredo da empresa e
 * compara em tempo constante.
 */

export function assinarWebhook(corpo: string, segredo: string, agoraSeg = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', segredo).update(`${agoraSeg}.${corpo}`).digest('hex')
  return `t=${agoraSeg},v1=${v1}`
}

export function verificarWebhook(
  corpo: string,
  cabecalho: string | undefined,
  segredo: string,
  toleranciaSeg = 300,
  agoraSeg = Math.floor(Date.now() / 1000),
): boolean {
  if (!cabecalho) return false
  const partes = Object.fromEntries(
    cabecalho.split(',').map((p) => {
      const i = p.indexOf('=')
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()]
    }),
  )
  const t = Number(partes.t)
  if (!Number.isInteger(t) || Math.abs(agoraSeg - t) > toleranciaSeg) return false
  if (typeof partes.v1 !== 'string' || !/^[0-9a-f]{64}$/.test(partes.v1)) return false
  const esperado = createHmac('sha256', segredo).update(`${t}.${corpo}`).digest()
  return timingSafeEqual(esperado, Buffer.from(partes.v1, 'hex'))
}
