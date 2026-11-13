-- Agendamentos e pedidos. As regras que não podem falhar ficam aqui, no banco.

create table agendamentos (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (id) on delete cascade,
  profissional_id uuid not null,
  cliente_id      uuid not null,
  servico_id      uuid not null,
  periodo         tstzrange not null,
  status          text not null default 'agendado'
                  check (status in ('agendado', 'confirmado', 'concluido', 'cancelado', 'faltou')),
  preco_centavos  integer not null check (preco_centavos >= 0),
  observacao      text not null default '' check (length(observacao) <= 500),
  criado_por      uuid,
  criado_em       timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, profissional_id) references profissionais (tenant_id, id),
  foreign key (tenant_id, cliente_id) references clientes (tenant_id, id),
  foreign key (tenant_id, servico_id) references servicos (tenant_id, id),

  -- Intervalo semiaberto [início, fim): 10:00-10:30 e 10:30-11:00 não colidem.
  constraint agendamentos_periodo_valido check (
    not isempty(periodo)
    and lower_inc(periodo) and not upper_inc(periodo)
    and not lower_inf(periodo) and not upper_inf(periodo)
    and upper(periodo) - lower(periodo) <= interval '8 hours'
  ),

  -- A regra central da agenda: o mesmo profissional não pode ter dois
  -- agendamentos ativos com períodos que se sobrepõem. Vale para qualquer
  -- cliente do banco (API, worker, script, psql), inclusive sob concorrência.
  constraint agendamentos_sem_sobreposicao exclude using gist (
    tenant_id with =,
    profissional_id with =,
    periodo with &&
  ) where (status in ('agendado', 'confirmado'))
);

-- Transições de status permitidas. Um agendamento concluído, cancelado ou
-- marcado como falta não volta a ocupar a agenda.
create function agendamentos_validar_transicao() returns trigger
  language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if old.status in ('concluido', 'cancelado', 'faltou') then
      raise exception 'Agendamento % não pode sair do status "%".', old.id, old.status
        using errcode = 'P0001', hint = 'transicao_invalida';
    end if;
    if old.status = 'confirmado' and new.status = 'agendado' then
      raise exception 'Agendamento confirmado não volta para "agendado".'
        using errcode = 'P0001', hint = 'transicao_invalida';
    end if;
  end if;
  if new.periodo is distinct from old.periodo or new.profissional_id is distinct from old.profissional_id then
    if old.status not in ('agendado', 'confirmado') then
      raise exception 'Só agendamentos ativos podem ser remarcados.'
        using errcode = 'P0001', hint = 'transicao_invalida';
    end if;
  end if;
  return new;
end
$$;

create trigger agendamentos_transicao
  before update on agendamentos
  for each row execute function agendamentos_validar_transicao();

create table pedidos (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants (id) on delete cascade,
  cliente_id         uuid,
  status             text not null default 'aberto' check (status in ('aberto', 'pago', 'cancelado')),
  total_centavos     integer not null default 0 check (total_centavos >= 0),
  chave_idempotencia text check (chave_idempotencia is null or length(chave_idempotencia) between 8 and 120),
  hash_requisicao    text,
  criado_por         uuid,
  criado_em          timestamptz not null default now(),
  unique (tenant_id, id),
  -- Uma chave de idempotência vale por empresa: a mesma requisição repetida
  -- devolve o mesmo pedido em vez de criar outro.
  unique (tenant_id, chave_idempotencia),
  foreign key (tenant_id, cliente_id) references clientes (tenant_id, id)
);

create table itens_pedido (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null,
  pedido_id               uuid not null,
  descricao               text not null check (length(descricao) between 1 and 200),
  quantidade              integer not null check (quantidade between 1 and 999),
  preco_unitario_centavos integer not null check (preco_unitario_centavos between 0 and 10000000),
  foreign key (tenant_id, pedido_id) references pedidos (tenant_id, id) on delete cascade
);

-- O total do pedido é sempre a soma dos itens. Gatilho por comando com tabela
-- de transição: um INSERT de 5 itens gera um único UPDATE no pedido.
create function pedidos_recalcular_total() returns trigger
  language plpgsql as $$
begin
  update pedidos p
     set total_centavos = coalesce((
           select sum(i.quantidade::bigint * i.preco_unitario_centavos)
             from itens_pedido i
            where i.tenant_id = p.tenant_id and i.pedido_id = p.id), 0)
   where (p.tenant_id, p.id) in (select distinct tenant_id, pedido_id from linhas);
  return null;
end
$$;

create trigger itens_pedido_total_insert
  after insert on itens_pedido
  referencing new table as linhas
  for each statement execute function pedidos_recalcular_total();

create trigger itens_pedido_total_delete
  after delete on itens_pedido
  referencing old table as linhas
  for each statement execute function pedidos_recalcular_total();
