insert into public.users (id, organization_id, full_name, email, role, status, auth_user_id)
values (gen_random_uuid(), 'a454287b-1f3e-42ee-bf1a-9ac4f49d8bd8', 'Plan Fix E2E', 'planfix-e2e2@trusttai.com', 'admin', 'active', 'e8eb7a6b-e205-45b9-baad-d1d784d13a90')
on conflict do nothing;

update auth.users set email_confirmed_at = now() where id = 'e8eb7a6b-e205-45b9-baad-d1d784d13a90' and email_confirmed_at is null;