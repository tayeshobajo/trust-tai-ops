insert into public.users (email, full_name, auth_user_id, role, organization_id, status)
select 'qa@trusttai.com', 'QA Team', 'c6f1c26f-1613-4830-8d79-23a08649940d'::uuid, 'admin', 'a454287b-1f3e-42ee-bf1a-9ac4f49d8bd8'::uuid, 'active'
where not exists (select 1 from public.users where lower(email) = 'qa@trusttai.com');

update public.users
   set auth_user_id = 'c6f1c26f-1613-4830-8d79-23a08649940d'::uuid,
       role = 'admin',
       organization_id = 'a454287b-1f3e-42ee-bf1a-9ac4f49d8bd8'::uuid,
       status = 'active'
 where lower(email) = 'qa@trusttai.com';