#!/usr/bin/env bash
# Restaura um backup num banco temporário e confere se ele serve de verdade.
# Backup que nunca foi restaurado é só esperança.
#
# Uso: scripts/restore-verify.sh [arquivo.dump]   (padrão: o mais recente em ./backups)
#
# Conexão: ADMIN_DATABASE_URL (superusuário). O banco temporário é apagado no
# fim; com MANTER=1 ele fica para inspeção. Sai com código 1 se algo falhar.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
: "${ADMIN_DATABASE_URL:?defina ADMIN_DATABASE_URL}"

ARQ="${1:-$(ls -1t backups/balcao-*.dump 2>/dev/null | head -1)}"
[ -f "$ARQ" ] || { echo "Nenhum backup encontrado." >&2; exit 1; }
if [ -f "$ARQ.sha256" ]; then (cd "$(dirname "$ARQ")" && sha256sum -c --quiet "$(basename "$ARQ").sha256"); fi

TEMP="balcao_verificacao_$(date +%s)"
URL_TEMP="$(node -e 'const u=new URL(process.argv[1]); u.pathname="/"+process.argv[2]; console.log(u.toString())' "$ADMIN_DATABASE_URL" "$TEMP")"
psql_admin() { psql -X -q -v ON_ERROR_STOP=1 -d "$ADMIN_DATABASE_URL" "$@"; }
psql_temp() { psql -X -q -At -v ON_ERROR_STOP=1 -d "$URL_TEMP" "$@"; }
[ "${MANTER:-0}" = 1 ] || trap 'psql_admin -c "drop database if exists $TEMP with (force)" >/dev/null 2>&1 || true' EXIT

SECONDS=0
# Papéis são do cluster, não do banco: num servidor novo eles ainda não existem.
psql_admin -c "do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'balcao_app') then create role balcao_app nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'balcao_worker') then create role balcao_worker nologin; end if;
end \$\$;"
psql_admin -c "create database $TEMP"
pg_restore --exit-on-error -j 2 -d "$URL_TEMP" "$ARQ"
DURACAO=$SECONDS

FALHAS=0
confere() { # descrição, sql, esperado
  local obtido; obtido="$(psql_temp -c "$2")"
  if [ "$obtido" = "$3" ]; then echo "  ok   $1"; else echo "  FALHOU $1 (esperado: $3, obtido: $obtido)"; FALHAS=$((FALHAS + 1)); fi
}

ESPERADA="$(ls db/migrations/*.sql | tail -1 | xargs basename | cut -c1-4)"
echo "Restaurado $ARQ em $TEMP em ${DURACAO}s. Conferindo:"
confere "migração mais recente é $ESPERADA" "select max(versao) from schema_migrations" "$ESPERADA"
confere "nenhuma migração faltando" "select count(*) from schema_migrations" "$(ls db/migrations/*.sql | wc -l | tr -d ' ')"
confere "RLS ligado e forçado em todas as tabelas com tenant_id" \
  "select count(*) from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace and not (c.relrowsecurity and c.relforcerowsecurity)" "0"
confere "restrição de exclusão da agenda presente" "select count(*) from pg_constraint where conname = 'agendamentos_sem_sobreposicao' and contype = 'x'" "1"
confere "gatilhos de auditoria presentes" "select count(*) from pg_trigger where tgname like 'auditoria_%'" "6"
confere "fila_resumo() pertence a balcao_worker" "select pg_get_userbyid(proowner) from pg_proc where proname = 'fila_resumo'" "balcao_worker"
confere "sem empresa definida, balcao_app não vê nada" "begin; set local role balcao_app; select count(*) from clientes; rollback;" "0"
COM_DADOS="$(psql_temp -c "select count(*) from tenants")"
if [ "$COM_DADOS" -gt 0 ]; then
  confere "com empresa definida, balcao_app vê só a própria" \
    "begin; set local role balcao_app; select set_config('app.tenant_id', (select id::text from tenants order by criado_em, id limit 1), true) is not null; select count(distinct tenant_id) from clientes; rollback;" "$(printf 't\n1')"
fi

echo "Contagem de linhas restauradas:"
for t in tenants usuarios clientes profissionais servicos agendamentos pedidos itens_pedido auditoria jobs outbox; do
  printf '  %-14s %s\n' "$t" "$(psql_temp -c "select count(*) from $t")"
done

if [ "$FALHAS" -gt 0 ]; then echo "Verificação FALHOU ($FALHAS problema(s))."; exit 1; fi
echo "Backup verificado: restaurável e com as garantias do esquema."
