import http from 'node:http'
import https from 'node:https'

/**
 * POST com node:http/https em vez de fetch. O fetch do Node segue a lista de
 * "portas ruins" da especificação Fetch e recusa destinos como a porta 4190;
 * o receptor de webhook de um cliente pode estar em qualquer porta.
 */
export type EnviarHttp = (
  url: string,
  opcoes: { headers: Record<string, string>; corpo: string; timeoutMs: number },
) => Promise<{ status: number }>

export const enviarHttp: EnviarHttp = (url, opcoes) =>
  new Promise((resolve, reject) => {
    const destino = new URL(url)
    const lib = destino.protocol === 'https:' ? https : http
    const req = lib.request(
      destino,
      {
        method: 'POST',
        headers: { ...opcoes.headers, 'content-length': Buffer.byteLength(opcoes.corpo) },
        timeout: opcoes.timeoutMs,
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error(`tempo esgotado após ${opcoes.timeoutMs} ms`)))
    req.on('error', reject)
    req.end(opcoes.corpo)
  })
