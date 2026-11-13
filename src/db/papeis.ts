import type pg from 'pg'

/**
 * As migrações criam os papéis balcao_app e balcao_worker sem login. Este passo
 * liga o login e define a senha a partir das URLs de conexão, para que a senha
 * exista num lugar só (o ambiente) e nunca dentro de uma migração versionada.
 */
export async function sincronizarPapeis(admin: pg.ClientBase, urls: string[]): Promise<string[]> {
  const feitos: string[] = []
  for (const url of urls) {
    const u = new URL(url)
    const papel = decodeURIComponent(u.username)
    const senha = decodeURIComponent(u.password)
    if (!['balcao_app', 'balcao_worker'].includes(papel)) {
      throw new Error(`Papel inesperado na URL: ${papel}. Use balcao_app ou balcao_worker.`)
    }
    if (senha.length < 8) throw new Error(`Senha do papel ${papel} precisa ter pelo menos 8 caracteres.`)
    const { rows } = await admin.query<{ cmd: string }>(
      `select format('alter role %I with login password %L connection limit 100', $1::text, $2::text) as cmd`,
      [papel, senha],
    )
    await admin.query(rows[0]!.cmd)
    feitos.push(papel)
  }
  return feitos
}
