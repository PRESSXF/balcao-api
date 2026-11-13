# Implantar numa VM Linux

Guia para colocar o Balcão no ar em qualquer máquina Linux com acesso root, sem depender de um provedor específico: uma VM de nuvem, um servidor dedicado ou um computador na empresa. Os exemplos usam Ubuntu 24.04; em Debian os comandos são os mesmos.

O resultado: PostgreSQL, API e worker em Docker; Caddy na frente com HTTPS automático; firewall só com SSH, HTTP e HTTPS; backup diário com verificação semanal.

## 1. Máquina

Mínimo para começar: 2 vCPU, 2 GB de RAM e 20 GB de disco. Aponte um domínio para o IP da máquina (registro `A`, por exemplo `api.seudominio.com.br`) antes do passo 5, porque o Caddy precisa dele para emitir o certificado.

Entre por SSH e atualize:

```bash
sudo apt update && sudo apt upgrade -y
sudo timedatectl set-timezone America/Recife
```

## 2. Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # saia e entre de novo no SSH
docker compose version
```

## 3. Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Atenção: portas publicadas pelo Docker **passam por cima do ufw**. Por isso, no passo 4, a API e o banco são publicados só em `127.0.0.1`. O único caminho de fora para dentro é o Caddy.

## 4. Aplicação

```bash
sudo mkdir -p /opt/balcao && sudo chown "$USER" /opt/balcao
git clone https://github.com/PRESSXF/balcao-api.git /opt/balcao
cd /opt/balcao
cp .env.example .env
```

Edite o `.env`. Gere cada senha e o segredo do JWT com `openssl rand -base64 36` (ou `48` para o JWT):

```ini
POSTGRES_PASSWORD=<senha forte>
APP_DB_PASSWORD=<outra senha forte>
WORKER_DB_PASSWORD=<outra senha forte>
JWT_SECRET=<openssl rand -base64 48>

# A API escuta só na interface local; o Caddy faz a ponte.
API_PORT=127.0.0.1:4280

# Sem contas de demonstração nem receptor de webhook de teste.
DEMO_MODE=false
LOG_LEVEL=info

# Para os scripts de backup que rodam fora do Docker.
ADMIN_DATABASE_URL=postgres://balcao:<POSTGRES_PASSWORD>@127.0.0.1:55432/balcao
```

Senhas com `@`, `:` ou `/` precisam de codificação de URL; prefira gerar só com letras e números (`openssl rand -hex 24`).

Suba:

```bash
docker compose up -d --build
docker compose ps                 # db healthy, migrate exited (0), api e worker healthy
curl -s http://127.0.0.1:4280/ready
```

O serviço `migrate` roda uma vez a cada `up`: aplica migrações pendentes e define as senhas dos papéis `balcao_app` e `balcao_worker` a partir do `.env`. A API e o worker só sobem depois dele terminar com sucesso.

Com `DEMO_MODE=false`, o banco começa vazio. Crie a primeira empresa e o dono por SQL:

```bash
docker compose exec db psql -U balcao -d balcao
```

```sql
insert into tenants (slug, nome, segmento) values ('minha-clinica', 'Minha Clínica', 'clinica') returning id;
-- gere o hash da senha: docker compose exec api node -e "import('./dist/auth/senha.js').then(m => m.gerarHash('SENHA').then(console.log))"
insert into usuarios (tenant_id, nome, email, senha_hash, papel)
values ('<id da empresa>', 'Nome do dono', 'dono@minhaclinica.com.br', '<hash>', 'dono');
```

## 5. Caddy com HTTPS

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```caddy
api.seudominio.com.br {
	encode zstd gzip

	# Métricas ficam só na rede interna (Prometheus na mesma máquina ou via VPN).
	@metrics path /metrics
	respond @metrics 404

	reverse_proxy 127.0.0.1:4280 {
		health_uri /ready
		health_interval 10s
	}

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
	}

	log {
		output file /var/log/caddy/balcao.log
		format json
	}
}
```

```bash
sudo systemctl reload caddy
curl -s https://api.seudominio.com.br/ready
```

O Caddy emite e renova o certificado sozinho. A API já confia no cabeçalho `X-Forwarded-For` (`trustProxy`), então o limite de login conta o IP real do cliente.

## 6. Backups

O backup lógico em formato custom (`pg_dump -Fc`) roda dentro do contêiner do banco, então a versão do `pg_dump` sempre bate com a do servidor. A verificação precisa do cliente do PostgreSQL 16 na máquina:

```bash
sudo apt install -y postgresql-client-16
```

`crontab -e`:

```cron
# Backup diário às 03:17, guardando 14 dias.
17 3 * * * cd /opt/balcao && BACKUP_VIA_COMPOSE=1 scripts/backup.sh /opt/balcao/backups >> /var/log/balcao-backup.log 2>&1

# Todo domingo, restaura o backup mais recente num banco temporário e confere.
40 4 * * 0 cd /opt/balcao && scripts/restore-verify.sh >> /var/log/balcao-backup.log 2>&1 || echo "verificação de backup falhou" | logger -t balcao
```

Backup que fica na mesma máquina some junto com ela. Copie a pasta para outro lugar depois do backup, por exemplo com `rclone` para um armazenamento de objetos compatível com S3:

```cron
47 3 * * * rclone copy /opt/balcao/backups remoto:balcao-backups --max-age 48h
```

Para restaurar de verdade (desastre), pare a API e o worker, recrie o banco e restaure:

```bash
docker compose stop api worker
docker compose exec -T db dropdb -U balcao balcao
docker compose exec -T db createdb -U balcao balcao
docker compose exec -T db pg_restore -U balcao -d balcao --exit-on-error < backups/balcao-AAAAMMDDTHHMMSSZ.dump
docker compose up -d
```

Os papéis `balcao_app` e `balcao_worker` são do cluster, não do banco, e não vêm no backup. Se o volume do PostgreSQL também foi perdido, suba só o `db`, rode `docker compose run --rm migrate` (cria os papéis e define as senhas do `.env`) e então siga os comandos acima: o `dropdb` descarta o esquema vazio que o `migrate` criou e o `pg_restore` traz os dados.

## 7. Atualizar

```bash
cd /opt/balcao
git pull
docker compose up -d --build
```

O `migrate` aplica as migrações novas antes de a API nova subir. Migrações só andam para a frente; para voltar, restaure o backup feito antes da atualização (rode `scripts/backup.sh` antes do `git pull`).

## 8. Acompanhar

```bash
docker compose logs -f api worker    # logs JSON, um por linha
docker compose ps
curl -s http://127.0.0.1:4280/metrics | grep balcao_fila
curl -s http://127.0.0.1:4191/metrics  # métricas do worker (de dentro do contêiner ou da rede do compose)
```

Sugestões de alerta: `/ready` diferente de 200 por mais de 1 minuto; `balcao_fila_atraso_segundos` acima de 300; `balcao_fila_jobs{status="morto"}` aumentando; disco acima de 80%.

## 9. Ajustes do PostgreSQL

Para uma VM de 4 GB, acrescente ao serviço `db` do `docker-compose.yml`:

```yaml
    command: >
      postgres
      -c shared_buffers=1GB
      -c effective_cache_size=3GB
      -c work_mem=16MB
      -c maintenance_work_mem=256MB
      -c max_connections=100
```

Cada processo da API usa até `DB_POOL_MAX` conexões (padrão 10) e o worker usa `WORKER_CONCURRENCY + 2`, mais uma para o `LISTEN`.
