-- Índices para as consultas reais da API e do worker. Cada um tem o EXPLAIN
-- ANALYZE com e sem o índice em docs/EXPLAIN.md (gerado por npm run explain).
--
-- Quase todos começam por tenant_id: toda consulta passa pela política
-- tenant_id = app_tenant(), e app_tenant() é STABLE, então o planejador usa
-- o valor como chave do índice.

-- Agenda do dia de uma empresa (GET /v1/agenda) e paginação de agendamentos.
create index agendamentos_tenant_inicio on agendamentos (tenant_id, lower(periodo), id);

-- Agendamentos de um cliente (chave estrangeira composta).
create index agendamentos_tenant_cliente on agendamentos (tenant_id, cliente_id);

-- Lista de clientes ordenada por nome com cursor (nome, id).
create index clientes_tenant_nome on clientes (tenant_id, nome, id);

-- Próximos jobs prontos. Índice parcial: só as linhas pendentes, que são
-- poucas, mesmo com milhões de jobs concluídos na tabela.
create index jobs_prontos on jobs (executar_em, id) where status = 'pendente';

-- Recuperação de jobs travados por worker que morreu.
create index jobs_travados on jobs (travado_em) where status = 'executando';

-- Painel: jobs recentes de uma empresa.
create index jobs_tenant_recentes on jobs (tenant_id, id desc);

create index outbox_tenant_recentes on outbox (tenant_id, id desc);
create index auditoria_tenant_recentes on auditoria (tenant_id, id desc);
create index pedidos_tenant_criado on pedidos (tenant_id, criado_em desc, id desc);
create index itens_pedido_pedido on itens_pedido (tenant_id, pedido_id);
create index refresh_tokens_usuario on refresh_tokens (tenant_id, usuario_id);
create index refresh_tokens_familia on refresh_tokens (familia) where revogado_em is null;
