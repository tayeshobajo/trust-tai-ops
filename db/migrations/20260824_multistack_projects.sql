-- Multi-stack projects.
--
-- Projects are no longer assumed to be WordPress. Environments carry an
-- explicit stack and a stack-agnostic version map, projects carry a deploy
-- pipeline description, and the access/task vocabularies widen.
--
-- Idempotent and non-destructive: legacy wordpress_version / php_version stay
-- in place and are backfilled into `versions`, so existing rows remain valid.

begin;

-- 1. Project-level deploy pipeline (description, not a workflow engine).
alter table projects add column if not exists deploy_pipeline jsonb;

-- 2. Environment stack + versions + runtime facts.
alter table project_environments add column if not exists stack text not null default 'wordpress';
alter table project_environments add column if not exists versions jsonb not null default '{}'::jsonb;
alter table project_environments add column if not exists runtime jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'project_environments_stack_check'
  ) then
    alter table project_environments
      add constraint project_environments_stack_check
      check (stack in ('wordpress', 'meteor', 'nextjs', 'custom'));
  end if;
end $$;

-- Legacy columns become optional. Dropping them would break older readers.
alter table project_environments alter column wordpress_version drop not null;
alter table project_environments alter column php_version drop not null;

-- 3. Backfill versions from the legacy WordPress columns.
update project_environments
set versions = coalesce(versions, '{}'::jsonb)
  || case when coalesce(wordpress_version, '') <> ''
       then jsonb_build_object('wordpress', wordpress_version) else '{}'::jsonb end
  || case when coalesce(php_version, '') <> ''
       then jsonb_build_object('php', php_version) else '{}'::jsonb end
where (coalesce(wordpress_version, '') <> '' and not (versions ? 'wordpress'))
   or (coalesce(php_version, '') <> '' and not (versions ? 'php'));

-- 4. Widen the access vocabulary.
alter table project_access_methods drop constraint if exists project_access_methods_access_type_check;
alter table project_access_methods
  add constraint project_access_methods_access_type_check
  check (access_type in (
    'wordpress_admin', 'sftp', 'ssh', 'hosting_portal', 'database', 'cdn',
    'server_pm2', 'ci_cd', 'container'
  ));

-- 5. Widen the task vocabulary.
alter table runs drop constraint if exists runs_task_type_check;
alter table runs
  add constraint runs_task_type_check
  check (task_type in (
    'malware', 'performance', 'broken_site', 'plugin_theme_conflict', 'hardening', 'qa_only',
    'deploy', 'migration', 'feature', 'dependency_upgrade'
  ));

commit;