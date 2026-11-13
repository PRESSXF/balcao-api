-- Extensões, papéis do banco e funções de contexto.
--
-- O usuário que roda as migrações é o dono das tabelas. A API e o worker
-- conectam com papéis próprios, sem superusuário e sem BYPASSRLS, para que as
-- políticas de Row Level Security valham para eles.

create extension if not exists btree_gist;
create extension if not exists citext;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'balcao_app') then
    create role balcao_app nologin nosuperuser nobypassrls noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'balcao_worker') then
    create role balcao_worker nologin nosuperuser nobypassrls noinherit;
  end if;
end
$$;

grant usage on schema public to balcao_app, balcao_worker;

-- Empresa da requisição atual. A API define com
--   select set_config('app.tenant_id', $1, true)
-- dentro da transação (equivale a SET LOCAL e some no COMMIT ou ROLLBACK).
-- Sem definição, devolve NULL e nenhuma política deixa linha passar.
create function app_tenant() returns uuid
  language sql stable parallel safe
  as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- Usuário autenticado, usado pela auditoria.
create function app_usuario() returns uuid
  language sql stable parallel safe
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
