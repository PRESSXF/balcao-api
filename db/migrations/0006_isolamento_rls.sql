-- Isolamento entre empresas com Row Level Security.
--
-- ENABLE liga as políticas; FORCE faz valer também para o dono da tabela
-- (sem FORCE, o dono passa direto). Superusuários e papéis com BYPASSRLS
-- sempre passam: por isso a API e o worker usam balcao_app e balcao_worker.

do $$
declare
  t text;
begin
  foreach t in array array[
    'usuarios', 'refresh_tokens', 'clientes', 'servicos', 'profissionais',
    'agendamentos', 'pedidos', 'itens_pedido', 'auditoria', 'jobs', 'outbox'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy isolamento_empresa on %I to balcao_app, balcao_worker '
      'using (tenant_id = app_tenant()) with check (tenant_id = app_tenant())', t);
  end loop;
end
$$;

-- Empresas: o diretório (id, slug, nome, segmento, fuso) é legível sem empresa
-- definida, porque o login começa pelo slug. As colunas de webhook ficam fora
-- do GRANT da API: só o worker lê, e só da empresa do job.
alter table tenants enable row level security;
alter table tenants force row level security;
create policy diretorio on tenants for select to balcao_app using (true);
create policy propria_empresa on tenants for select to balcao_worker using (id = app_tenant());

-- O worker enxerga a fila inteira para escolher o próximo job de qualquer
-- empresa. Ao executar, ele define app.tenant_id com a empresa do job e passa
-- a obedecer às mesmas políticas da API.
create policy worker_fila on jobs to balcao_worker using (true) with check (true);

-- Permissões mínimas da API.
grant select (id, slug, nome, segmento, fuso, criado_em) on tenants to balcao_app;
grant select, insert, update on usuarios to balcao_app;
grant select, insert, update on refresh_tokens to balcao_app;
grant select, insert, update, delete on clientes, servicos, profissionais, agendamentos, pedidos to balcao_app;
grant select, insert, delete on itens_pedido to balcao_app;
grant select, insert on auditoria to balcao_app;
grant select, insert on jobs to balcao_app;
grant select on outbox to balcao_app;

-- Permissões mínimas do worker.
grant select on tenants to balcao_worker;
grant select on clientes, servicos, profissionais, agendamentos to balcao_worker;
grant select, update on jobs to balcao_worker;
grant select, insert on outbox to balcao_worker;

grant usage on all sequences in schema public to balcao_app, balcao_worker;

-- /ready compara a versão do banco com a do código.
grant select on schema_migrations to balcao_app, balcao_worker;

-- Resumo da fila para métricas e para o painel: só contagens, nunca linhas.
-- Roda com os direitos de balcao_worker (que vê a fila toda) e pode ser
-- chamada pela API sem empresa definida.
create function fila_resumo()
  returns table (tipo text, status text, total bigint, mais_antigo timestamptz)
  language sql stable security definer
  set search_path = public, pg_temp
  as $$
    select j.tipo, j.status, count(*), min(j.executar_em)
      from jobs j
     group by j.tipo, j.status
  $$;
alter function fila_resumo() owner to balcao_worker;
revoke all on function fila_resumo() from public;
grant execute on function fila_resumo() to balcao_app, balcao_worker;
