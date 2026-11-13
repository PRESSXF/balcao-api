#!/usr/bin/env bash
# Backup lógico do banco em formato custom do pg_dump (-Fc): comprimido,
# restaurável por tabela e em paralelo com pg_restore -j.
#
# Uso:
#   scripts/backup.sh [pasta]                      # padrão: ./backups
#   BACKUP_VIA_COMPOSE=1 scripts/backup.sh         # usa o pg_dump do contêiner "db"
#
# Conexão direta: ADMIN_DATABASE_URL. Arquivos com mais de
# BACKUP_RETENTION_DAYS dias (padrão 14) são apagados. Agende no cron
# (veja docs/DEPLOY.md) e copie a pasta para fora da máquina.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

PASTA="${1:-backups}"
RETENCAO="${BACKUP_RETENTION_DAYS:-14}"
mkdir -p "$PASTA"
ARQ="$PASTA/balcao-$(date -u +%Y%m%dT%H%M%SZ).dump"

if [ "${BACKUP_VIA_COMPOSE:-0}" = 1 ]; then
  docker compose exec -T db pg_dump -U "${POSTGRES_USER:-balcao}" -d "${POSTGRES_DB:-balcao}" -Fc -Z 6 > "$ARQ.parcial"
else
  : "${ADMIN_DATABASE_URL:?defina ADMIN_DATABASE_URL ou use BACKUP_VIA_COMPOSE=1}"
  pg_dump -d "$ADMIN_DATABASE_URL" -Fc -Z 6 -f "$ARQ.parcial"
fi

# Só vira backup "de verdade" depois de terminar e ser legível.
pg_restore --list "$ARQ.parcial" >/dev/null
mv "$ARQ.parcial" "$ARQ"
(cd "$PASTA" && sha256sum "$(basename "$ARQ")" > "$(basename "$ARQ").sha256")

find "$PASTA" -name 'balcao-*.dump*' -type f -mtime +"$RETENCAO" -delete
echo "Backup: $ARQ ($(du -h "$ARQ" | cut -f1))"
