-- Fila de jobs dentro do PostgreSQL.
--
-- O job nasce na mesma transação que o criou (o agendamento e o lembrete são
-- gravados juntos ou nenhum dos dois). Workers pegam jobs com
-- FOR UPDATE SKIP LOCKED, então dois workers nunca levam o mesmo job, e são
-- acordados por NOTIFY em vez de ficar consultando a tabela sem parar.

create table jobs (
  id                 bigint generated always as identity primary key,
  tenant_id          uuid not null references tenants (id) on delete cascade,
  tipo               text not null check (tipo in ('lembrete_agendamento', 'entrega_webhook')),
  payload            jsonb not null default '{}',
  status             text not null default 'pendente'
                     check (status in ('pendente', 'executando', 'concluido', 'morto')),
  tentativas         integer not null default 0 check (tentativas >= 0),
  max_tentativas     integer not null default 5 check (max_tentativas between 1 and 25),
  executar_em        timestamptz not null default now(),
  travado_em         timestamptz,
  travado_por        text,
  ultimo_erro        text,
  resultado          text,
  chave_idempotencia text check (chave_idempotencia is null or length(chave_idempotencia) <= 200),
  criado_em          timestamptz not null default now(),
  concluido_em       timestamptz,
  unique (tenant_id, chave_idempotencia),
  check ((status = 'executando') = (travado_em is not null))
);

-- Saída de mensagens. O lembrete "envia" WhatsApp gravando aqui (envio
-- simulado); o webhook registra cada entrega bem-sucedida. A chave única torna
-- o efeito idempotente: se o job rodar duas vezes, a mensagem sai uma vez só.
create table outbox (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references tenants (id) on delete cascade,
  canal       text not null check (canal in ('whatsapp', 'webhook')),
  destino     text not null,
  conteudo    jsonb not null,
  status_http integer,
  job_id      bigint references jobs (id) on delete set null,
  chave       text not null,
  criado_em   timestamptz not null default now(),
  unique (tenant_id, chave)
);

-- Acorda os workers quando há trabalho para agora. A notificação só é entregue
-- no COMMIT; notificações iguais na mesma transação viram uma só.
create function jobs_notificar() returns trigger
  language plpgsql as $$
begin
  if new.status = 'pendente' and new.executar_em <= now() + interval '1 second' then
    perform pg_notify('balcao_jobs', new.tipo);
  end if;
  return null;
end
$$;

create trigger jobs_notificar
  after insert or update of status, executar_em on jobs
  for each row execute function jobs_notificar();
