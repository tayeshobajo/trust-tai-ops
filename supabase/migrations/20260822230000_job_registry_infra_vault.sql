-- Phase 4: Job Registry + Org Infra Credential Vault
-- captain_job_types: catalog of Captain capabilities (what Ops knows Captain can do)
-- org_infra_secrets: org-scoped encrypted infrastructure credentials
--   (cPanel API, DigitalOcean, Cloudflare, GoDaddy API, etc.)
--   Same AES-GCM envelope pattern as project_access_secrets.

-- ============ Job Registry ============

create table if not exists public.captain_job_types (
  id                    uuid primary key default gen_random_uuid(),
  job_type              text not null unique,          -- ssl_install, ssl_renew, wp_plugin_install...
  label                 text not null,                 -- human label: "Install SSL certificate"
  description           text,
  maps_to_task_type     text,                          -- TaskType in the run model (hardening, deploy, feature...)
  required_credentials  text[] not null default '{}',  -- credential_types needed: {cpanel_api}, {wordpress_admin}...
  cloud_ready           boolean not null default false,-- can run on DO droplet without Tai's laptop
  trigger_kind          text not null default 'manual' check (trigger_kind in ('manual', 'cron', 'monitor')),
  match_patterns        text[] not null default '{}',  -- regex patterns for auto-resolution from brief text
  enabled               boolean not null default true,
  sort_order            integer not null default 100,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index idx_captain_job_types_enabled on public.captain_job_types(enabled, sort_order);

alter table public.captain_job_types enable row level security;

create policy "Service role manages job types"
  on public.captain_job_types for all
  to service_role using (true) with check (true);

create policy "Authenticated can read job types"
  on public.captain_job_types for select
  to authenticated using (enabled);

create or replace function public.set_captain_job_types_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger tg_captain_job_types_updated_at
  before update on public.captain_job_types
  for each row execute function public.set_captain_job_types_updated_at();

-- Seed catalog (brief §5)
insert into public.captain_job_types
  (job_type, label, description, maps_to_task_type, required_credentials, cloud_ready, trigger_kind, match_patterns, sort_order)
values
  ('ssl_install',
   'Install SSL certificate',
   'Issue and install a Let''s Encrypt certificate via certbot HTTP-01 + host API (cPanel UAPI or equivalent).',
   'hardening', '{cpanel_api}', false, 'manual',
   '{certificat,ssl,https,lets encrypt}', 10),
  ('ssl_renew',
   'Renew SSL certificate',
   'Renew a certificate nearing expiry. Same path as install; renewal window is 75 days pre-expiry.',
   'hardening', '{cpanel_api}', false, 'cron',
   '{renew,expir}', 11),
  ('ssl_verify',
   'Verify certificate health',
   'Read-only check: issuer, validity window, SNI match. No changes.',
   'qa_only', '{}', true, 'monitor',
   '{verify cert}', 12),
  ('wp_plugin_install',
   'Install WordPress plugin',
   'Install and activate a plugin on a WordPress site via WP-CLI or REST.',
   'feature', '{wordpress_admin}', true, 'manual',
   '{install plugin,add plugin}', 20),
  ('wp_plugin_update',
   'Update WordPress plugin(s)',
   'Update plugins with pre/post state capture. Monitor-queueable.',
   'dependency_upgrade', '{wordpress_admin}', true, 'monitor',
   '{update plugin,plugin update,outdated}', 21),
  ('wp_debug_fix',
   'Diagnose and fix WordPress issue',
   'Inspect live site, error logs, plugin list; identify root cause; fix with backup-first.',
   'broken_site', '{wordpress_admin}', true, 'manual',
   '{debug,fix,broken,error,500,white screen}', 22),
  ('dns_verify',
   'Verify DNS records',
   'Read-only DNS resolution check for a domain.',
   'qa_only', '{}', true, 'monitor',
   '{dns}', 30),
  ('deploy_static',
   'Deploy static site / frontend',
   'Build and deploy a static or frontend project to its host.',
   'deploy', '{deploy_pipeline}', true, 'manual',
   '{deploy}', 40),
  ('client_brief_create',
   'Create client brief',
   'Draft a BRIEF.md for a project from context.',
   'feature', '{}', true, 'manual',
   '{brief}', 50),
  ('prospect_research',
   'Research a prospect company',
   'ICP-matched company research feeding the Scout pipeline.',
   'feature', '{}', true, 'manual',
   '{research,prospect}', 60)
on conflict (job_type) do nothing;

-- ============ Org Infra Secrets ============

create table if not exists public.org_infra_secrets (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  credential_type     text not null check (credential_type in (
                        'cpanel_api', 'digitalocean', 'cloudflare', 'godaddy_api',
                        'resend', 'stripe', 'wpengine', 'sftp_generic')),
  label               text not null,                   -- e.g. "GoDaddy cPanel — deerparkranch"
  ciphertext          text not null,
  iv                  text not null,
  algorithm           text not null default 'AES-GCM',
  key_version         text not null default 'v1',
  config              jsonb not null default '{}'::jsonb, -- non-secret metadata: host, username, scopes
  verification_state  text not null default 'unverified' check (verification_state in ('unverified','verified','rejected')),
  last_verified_at    timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (organization_id, credential_type, label)
);

create index idx_org_infra_secrets_org on public.org_infra_secrets(organization_id, credential_type);

alter table public.org_infra_secrets enable row level security;

-- No client policies at all: ciphertext never reaches the browser.
-- All access is service-role inside edge functions.

create or replace function public.set_org_infra_secrets_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger tg_org_infra_secrets_updated_at
  before update on public.org_infra_secrets
  for each row execute function public.set_org_infra_secrets_updated_at();
