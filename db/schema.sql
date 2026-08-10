create extension if not exists pgcrypto;

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  descriptor text not null,
  subdomain text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  full_name text not null,
  email text not null,
  role text not null check (role in ('viewer', 'operator', 'senior_operator', 'admin')),
  status text not null default 'active' check (status in ('active', 'invited', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, email)
);

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  client_name text not null,
  primary_domain text not null,
  status text not null check (status in ('active', 'watchlist', 'blocked')),
  environment_health text not null check (environment_health in ('stable', 'watching', 'at_risk')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists project_environments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  environment_type text not null check (environment_type in ('production', 'staging', 'development')),
  primary_url text not null,
  hosting_provider text not null,
  wordpress_version text not null,
  php_version text not null,
  cache_layers text[] not null default '{}',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists project_access_methods (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  environment_id uuid references project_environments(id) on delete set null,
  access_type text not null check (access_type in ('wordpress_admin', 'sftp', 'ssh', 'hosting_portal', 'database', 'cdn')),
  label text not null,
  status text not null check (status in ('available', 'stale', 'missing')),
  auth_method text not null,
  credential_reference text,
  last_verified_at timestamptz,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists project_memory_entries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  environment_id uuid references project_environments(id) on delete set null,
  memory_type text not null check (memory_type in ('stack_note', 'incident_note', 'risk_note', 'qa_rule', 'procedure')),
  importance text not null check (importance in ('medium', 'high', 'critical')),
  title text not null,
  content text not null,
  source_run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists qa_rules (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  environment_id uuid references project_environments(id) on delete set null,
  name text not null,
  rule_type text not null check (rule_type in ('availability_check', 'login_check', 'visual_check', 'security_check', 'performance_check', 'regression_check')),
  required boolean not null default true,
  description text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists project_risk_flags (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  environment_id uuid references project_environments(id) on delete set null,
  severity text not null check (severity in ('medium', 'high', 'critical')),
  status text not null check (status in ('open', 'monitoring', 'mitigated', 'resolved')),
  title text not null,
  summary text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists project_recommendations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  run_id uuid,
  category text not null check (category in ('security', 'performance', 'stability', 'maintenance', 'process')),
  priority text not null check (priority in ('medium', 'high', 'critical')),
  status text not null check (status in ('open', 'reviewed', 'accepted', 'deferred', 'resolved')),
  title text not null,
  summary text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  environment_id uuid not null references project_environments(id) on delete restrict,
  created_by_user_id uuid references users(id) on delete set null,
  title text not null,
  task_type text not null check (task_type in ('malware', 'performance', 'broken_site', 'plugin_theme_conflict', 'hardening', 'qa_only')),
  task_summary text not null,
  urgency text not null check (urgency in ('normal', 'urgent', 'critical')),
  state text not null check (state in ('intake', 'access_check', 'backup_gate', 'environment_mapping', 'diagnosis', 'plan', 'execution', 'qa', 'recommendations', 'complete', 'paused', 'escalated', 'failed', 'rolled_back')),
  risk_level text not null check (risk_level in ('safe', 'cautious', 'high_risk')),
  backup_status text not null check (backup_status in ('unconfirmed', 'confirmed_by_operator', 'evidence_attached', 'restore_point_verified')),
  approval_required boolean not null default false,
  next_action text not null,
  operator_prompt text not null,
  diagnosis_summary text not null default '',
  plan_summary text not null default '',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists run_phases (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  state text not null check (state in ('intake', 'access_check', 'backup_gate', 'environment_mapping', 'diagnosis', 'plan', 'execution', 'qa', 'recommendations', 'complete', 'paused', 'escalated', 'failed', 'rolled_back')),
  label text not null,
  summary text not null,
  status text not null check (status in ('pending', 'active', 'completed', 'blocked', 'failed')),
  created_at timestamptz not null default now()
);

create table if not exists run_findings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  title text not null,
  summary text not null,
  created_at timestamptz not null default now()
);

create table if not exists run_actions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  actor text not null check (actor in ('agent', 'operator', 'system')),
  summary text not null,
  outcome text not null check (outcome in ('pending', 'succeeded', 'failed')),
  created_at timestamptz not null default now()
);

create table if not exists run_artifacts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  artifact_type text not null check (artifact_type in ('backup_note', 'scan_result', 'diff_summary', 'qa_capture', 'report')),
  title text not null,
  summary text not null,
  storage_ref text,
  created_at timestamptz not null default now()
);

create table if not exists run_approvals (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  approval_type text not null check (approval_type in ('high_risk_execution', 'qa_waiver', 'rollback')),
  status text not null check (status in ('pending', 'approved', 'rejected')),
  reason text not null,
  approved_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create table if not exists qa_reports (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null unique references runs(id) on delete cascade,
  verdict text not null check (verdict in ('passed', 'failed', 'partial', 'waived')),
  summary text not null,
  unresolved_risks text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists qa_results (
  id uuid primary key default gen_random_uuid(),
  qa_report_id uuid not null references qa_reports(id) on delete cascade,
  qa_rule_id uuid references qa_rules(id) on delete set null,
  name text not null,
  result text not null check (result in ('passed', 'failed', 'warning', 'skipped')),
  notes text not null,
  created_at timestamptz not null default now()
);

create table if not exists run_recommendations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  category text not null check (category in ('security', 'performance', 'stability', 'maintenance', 'process')),
  priority text not null check (priority in ('medium', 'high', 'critical')),
  status text not null check (status in ('open', 'reviewed', 'accepted', 'deferred', 'resolved')),
  title text not null,
  summary text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Persistent conversation ------------------------------------------------
create table if not exists project_messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  run_id uuid references runs(id) on delete set null,
  role text not null check (role in ('user', 'agent', 'system')),
  kind text not null check (kind in ('message', 'status_update', 'decision_request', 'decision_response')),
  body text[] not null default '{}',
  dedupe_key text,
  source_key text,
  created_at timestamptz not null default now()
);

create index if not exists project_messages_project_created_idx
  on project_messages (project_id, created_at);
create index if not exists project_messages_run_created_idx
  on project_messages (run_id, created_at);
create unique index if not exists project_messages_dedupe_idx
  on project_messages (project_id, dedupe_key)
  where dedupe_key is not null;

-- Memory provenance (optional; existing rows stay null).
alter table project_memory_entries
  add column if not exists source_run_id uuid references runs(id) on delete set null;
alter table project_memory_entries
  add column if not exists source_message_id uuid references project_messages(id) on delete set null;
