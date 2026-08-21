alter table public.project_access_methods drop constraint project_access_methods_access_type_check;
alter table public.project_access_methods add constraint project_access_methods_access_type_check
  check (access_type = any (array['wordpress_admin','sftp','ftp','ssh','hosting_portal','database','cdn','server_pm2','ci_cd','container','google_search_console']));
alter table public.project_access_secrets drop constraint project_access_secrets_access_type_check;
alter table public.project_access_secrets add constraint project_access_secrets_access_type_check
  check (access_type = any (array['wordpress_admin','sftp','ftp','ssh','hosting_portal','database','cdn','google_search_console']));