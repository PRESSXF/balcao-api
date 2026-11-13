#!/usr/bin/env bash
# Roda os testes unitários e de integração contra um PostgreSQL 16 de verdade.
#
# De onde vem o banco, nesta ordem:
#   1. TEST_DATABASE_URL já definida (CI, banco seu): usa direto;
#   2. Docker disponível: sobe postgres:16 descartável;
#   3. binários do PostgreSQL 16 instalados (initdb/pg_ctl): cria um cluster
#      temporário e apaga no fim.
# A porta padrão é 55439 (TEST_DB_PORT), para não brigar com o banco do docker compose (55432).
set -euo pipefail
cd "$(dirname "$0")/.."

PORTA="${TEST_DB_PORT:-55439}"
LIMPAR=()
limpar() { for c in "${LIMPAR[@]:-}"; do [ -n "$c" ] && eval "$c" >/dev/null 2>&1 || true; done; }
trap limpar EXIT

com_docker() {
  command -v docker >/dev/null && docker info >/dev/null 2>&1 || return 1
  echo "Subindo postgres:16 descartável no Docker (porta $PORTA)..."
  docker run -d --rm --name balcao-teste-pg -e POSTGRES_PASSWORD=postgres -p "127.0.0.1:$PORTA:5432" postgres:16 >/dev/null || return 1
  LIMPAR+=("docker stop balcao-teste-pg")
  for _ in $(seq 1 60); do docker exec balcao-teste-pg pg_isready -U postgres >/dev/null 2>&1 && break; sleep 0.5; done
  export TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:$PORTA/postgres"
}

com_binarios_locais() {
  local BIN DIR COMO=()
  BIN="$(dirname "$(command -v initdb 2>/dev/null || echo /usr/lib/postgresql/16/bin/initdb)")"
  [ -x "$BIN/initdb" ] || return 1
  if "$BIN/pg_isready" -q -h 127.0.0.1 -p "$PORTA"; then
    echo "A porta $PORTA já está em uso. Escolha outra com TEST_DB_PORT." >&2
    return 1
  fi
  DIR="$(mktemp -d /var/tmp/balcao-teste-pg.XXXXXX)"
  # initdb não roda como root: usa o usuário postgres do sistema, se houver.
  if [ "$(id -u)" = 0 ]; then chown postgres "$DIR"; COMO=(runuser -u postgres --); fi
  echo "Criando cluster PostgreSQL temporário em $DIR (porta $PORTA)..."
  "${COMO[@]}" "$BIN/initdb" -D "$DIR/dados" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null || return 1
  "${COMO[@]}" "$BIN/pg_ctl" -D "$DIR/dados" -o "-p $PORTA -k $DIR -c fsync=off -c max_connections=200" -l "$DIR/log" -w start >/dev/null || { cat "$DIR/log" >&2; return 1; }
  LIMPAR+=("${COMO[*]} $BIN/pg_ctl -D $DIR/dados -m fast stop" "rm -rf $DIR")
  export TEST_DATABASE_URL="postgres://postgres@127.0.0.1:$PORTA/postgres"
}

if [ -n "${TEST_DATABASE_URL:-}" ]; then
  echo "Usando TEST_DATABASE_URL já definida."
elif ! com_docker && ! com_binarios_locais; then
  echo "Sem Docker utilizável e sem initdb do PostgreSQL 16. Defina TEST_DATABASE_URL." >&2
  exit 1
fi

npm test
npm run test:integration
