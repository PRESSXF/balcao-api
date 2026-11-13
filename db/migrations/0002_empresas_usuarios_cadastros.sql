-- Empresas (tenants), usuários, tokens de renovação e cadastros básicos.
--
-- Toda tabela de empresa tem tenant_id e uma chave única (tenant_id, id). As
-- referências entre tabelas usam a chave composta, então um agendamento da
-- empresa A não consegue apontar para um profissional da empresa B nem por
-- engano: a chave estrangeira falha.

create table tenants (
  id              uuid primary key default gen_random_uuid(),
  slug            citext not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 60),
  nome            text not null check (length(nome) between 2 and 120),
  segmento        text not null check (segmento in ('clinica', 'salao', 'restaurante')),
  fuso            text not null default 'America/Recife',
  webhook_url     text check (webhook_url is null or webhook_url ~ '^https?://'),
  webhook_segredo text check (webhook_segredo is null or length(webhook_segredo) >= 24),
  criado_em       timestamptz not null default now(),
  check ((webhook_url is null) = (webhook_segredo is null))
);

create table usuarios (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants (id) on delete cascade,
  nome       text not null check (length(nome) between 2 and 120),
  email      citext not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  senha_hash text not null check (senha_hash like 'scrypt$%'),
  papel      text not null check (papel in ('dono', 'atendente')),
  ativo      boolean not null default true,
  criado_em  timestamptz not null default now(),
  unique (tenant_id, email),
  unique (tenant_id, id)
);

-- Tokens de renovação: guardamos só o SHA-256 do segredo. Cada login abre uma
-- família; cada renovação marca o token como usado e cria o próximo da mesma
-- família. Reuso de um token já usado revoga a família inteira.
create table refresh_tokens (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  usuario_id  uuid not null,
  familia     uuid not null,
  token_hash  bytea not null check (length(token_hash) = 32),
  expira_em   timestamptz not null,
  usado_em    timestamptz,
  revogado_em timestamptz,
  criado_em   timestamptz not null default now(),
  foreign key (tenant_id, usuario_id) references usuarios (tenant_id, id) on delete cascade
);

create table clientes (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  nome      text not null check (length(nome) between 2 and 120),
  telefone  text not null check (telefone ~ '^\+55[1-9][0-9]{9,10}$'),
  email     citext check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  criado_em timestamptz not null default now(),
  unique (tenant_id, telefone),
  unique (tenant_id, id)
);

create table servicos (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id) on delete cascade,
  nome           text not null check (length(nome) between 2 and 120),
  duracao_min    integer not null check (duracao_min between 5 and 480),
  preco_centavos integer not null check (preco_centavos between 0 and 10000000),
  ativo          boolean not null default true,
  criado_em      timestamptz not null default now(),
  unique (tenant_id, nome),
  unique (tenant_id, id)
);

-- "Profissional" é quem ou o que tem agenda: a dermatologista, o barbeiro ou a
-- mesa da varanda de um restaurante.
create table profissionais (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  nome          text not null check (length(nome) between 2 and 120),
  especialidade text not null default '',
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now(),
  unique (tenant_id, id)
);
