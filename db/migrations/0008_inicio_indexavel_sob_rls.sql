-- O índice (tenant_id, lower(periodo)) da 0007 não era usado pela agenda.
--
-- Motivo (visto no EXPLAIN ANALYZE): com RLS, o PostgreSQL só aplica uma
-- condição da consulta antes do filtro da política, e portanto só a usa como
-- chave de índice, se as funções envolvidas forem LEAKPROOF. Uma função que
-- não é leakproof poderia vazar, numa mensagem de erro, o valor de uma linha de
-- outra empresa. lower(tstzrange) não é leakproof; a comparação entre
-- timestamptz é. O plano caía num índice só por tenant_id e descartava, linha
-- a linha, os agendamentos dos outros dias.
--
-- Solução: o início vira uma coluna gerada (sempre igual a lower(periodo)) e o
-- índice usa a coluna.

alter table agendamentos add column inicio timestamptz generated always as (lower(periodo)) stored;

drop index agendamentos_tenant_inicio;
create index agendamentos_tenant_inicio on agendamentos (tenant_id, inicio, id);
