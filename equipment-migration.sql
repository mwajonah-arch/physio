-- Run after inventory-migration.sql. Adds equipment fields and drops the
-- pharmacy-only prescription flag. Safe to re-run.
alter table public.inventory add column if not exists brand text not null default '';
alter table public.inventory add column if not exists warranty_months integer not null default 0 check (warranty_months >= 0);
alter table public.inventory drop column if exists requires_rx;
