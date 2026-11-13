-- Auditoria preenchida por gatilhos: quem, o quê, antes e depois.
--
-- Como é o banco que grava, nenhuma alteração escapa, venha da API, do worker
-- ou de um psql aberto em produção. O papel da API só pode inserir e ler: não
-- tem UPDATE nem DELETE nesta tabela.

create table auditoria (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references tenants (id) on delete cascade,
  tabela      text not null,
  registro_id uuid,
  acao        text not null check (acao in ('INSERT', 'UPDATE', 'DELETE')),
  usuario_id  uuid,
  requisicao  text,
  antes       jsonb,
  depois      jsonb,
  em          timestamptz not null default now()
);

create function auditar() returns trigger
  language plpgsql as $$
declare
  v_antes  jsonb;
  v_depois jsonb;
  v_linha  jsonb;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_antes := to_jsonb(old) - 'senha_hash';
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_depois := to_jsonb(new) - 'senha_hash';
  end if;
  -- UPDATE que não muda nada não gera registro.
  if tg_op = 'UPDATE' and v_antes = v_depois then
    return new;
  end if;
  v_linha := coalesce(v_depois, v_antes);

  insert into auditoria (tenant_id, tabela, registro_id, acao, usuario_id, requisicao, antes, depois)
  values (
    (v_linha ->> 'tenant_id')::uuid,
    tg_table_name,
    (v_linha ->> 'id')::uuid,
    tg_op,
    app_usuario(),
    nullif(current_setting('app.request_id', true), ''),
    v_antes,
    v_depois
  );
  return coalesce(new, old);
end
$$;

create trigger auditoria_usuarios      after insert or update or delete on usuarios      for each row execute function auditar();
create trigger auditoria_clientes      after insert or update or delete on clientes      for each row execute function auditar();
create trigger auditoria_servicos      after insert or update or delete on servicos      for each row execute function auditar();
create trigger auditoria_profissionais after insert or update or delete on profissionais for each row execute function auditar();
create trigger auditoria_agendamentos  after insert or update or delete on agendamentos  for each row execute function auditar();
create trigger auditoria_pedidos       after insert or update or delete on pedidos       for each row execute function auditar();
