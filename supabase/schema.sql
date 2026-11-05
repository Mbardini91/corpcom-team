-- =====================================================================
--  منصة فريق إدارة الاتصال — هيكل قاعدة البيانات والصلاحيات (Supabase)
--  شغّل هذا الملف مرة واحدة من: SQL Editor → New query → Run
-- =====================================================================

-- 1) جدول البيانات: كل سجلات المنصة (مهام، إجازات، عطل، رصد، سوشيال، إعدادات)
create table if not exists public.docs (
  col        text        not null,               -- اسم المجموعة: tasks / leaves / holidays / monitor ...
  id         text        not null,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid                 default auth.uid(),
  primary key (col, id)
);
alter table public.docs replica identity full;      -- لتصل عمليات الحذف للتحديث اللحظي

create or replace function public.docs_touch() returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before insert or update on public.docs for each row execute function public.docs_touch();

-- 2) قائمة المصرّح لهم بالدخول (إيميل بأحرف صغيرة، أو رقم هاتف بالأرقام فقط مع مفتاح الدولة مثل 97333123456)
create table if not exists public.team_access (
  contact text primary key,
  name    text,
  role    text not null default 'member' check (role in ('member','viewer','admin'))
);

-- 3) دوال التحقق من الصلاحية
create or replace function public.norm_contact(t text) returns text
language sql immutable set search_path = public as $$
  select case when coalesce(t,'') like '%@%' then lower(trim(t))
              else regexp_replace(coalesce(t,''), '\D', '', 'g') end
$$;

create or replace function public.my_contacts() returns text[]
language sql stable set search_path = public as $$
  select array_remove(array[
    nullif(public.norm_contact(auth.jwt() ->> 'email'), ''),
    nullif(public.norm_contact(auth.jwt() ->> 'phone'), '')
  ], null)
$$;

create or replace function public.my_membership() returns table(name text, role text)
language sql stable security definer set search_path = public as $$
  select t.name, t.role from public.team_access t
  where public.norm_contact(t.contact) = any(public.my_contacts())
  order by case t.role when 'admin' then 0 when 'member' then 1 else 2 end
  limit 1
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.team_access t where public.norm_contact(t.contact) = any(public.my_contacts()))
$$;

create or replace function public.can_write() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.team_access t
                where public.norm_contact(t.contact) = any(public.my_contacts()) and t.role in ('member','admin'))
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.team_access t
                where public.norm_contact(t.contact) = any(public.my_contacts()) and t.role = 'admin')
$$;

-- تُستخدم في شاشة الدخول للتأكد أن الإيميل/الرقم ضمن الفريق قبل إرسال الرمز
create or replace function public.can_login(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.team_access t where public.norm_contact(t.contact) = public.norm_contact(p))
$$;

revoke all on function public.can_login(text) from public;
grant execute on function public.can_login(text)   to anon, authenticated;
revoke all on function public.my_membership() from public, anon;
revoke all on function public.is_member() from public, anon;
revoke all on function public.can_write() from public, anon;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.my_membership()   to authenticated;
grant execute on function public.is_member()       to authenticated;
grant execute on function public.can_write()       to authenticated;
grant execute on function public.is_admin()        to authenticated;

-- 4) صلاحيات الصفوف (RLS)
alter table public.docs        enable row level security;
alter table public.team_access enable row level security;

drop policy if exists docs_read   on public.docs;
drop policy if exists docs_insert on public.docs;
drop policy if exists docs_update on public.docs;
drop policy if exists docs_delete on public.docs;
create policy docs_read   on public.docs for select to authenticated using (public.is_member());
create policy docs_insert on public.docs for insert to authenticated with check (public.can_write());
create policy docs_update on public.docs for update to authenticated using (public.can_write()) with check (public.can_write());
create policy docs_delete on public.docs for delete to authenticated using (public.can_write());

drop policy if exists ta_admin_all on public.team_access;
create policy ta_admin_all on public.team_access for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- 5) التحديث اللحظي بين الأجهزة
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- 6) تخزين صور الأخبار والمنشورات
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('images', 'images', true, 8388608, array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do nothing;

drop policy if exists images_insert on storage.objects;
drop policy if exists images_delete on storage.objects;
-- الحاوية عامة: الصور تُعرض بروابطها المباشرة دون الحاجة لسياسة قراءة (تمنع سرد الملفات)
create policy images_insert on storage.objects for insert to authenticated with check (bucket_id = 'images' and public.can_write());
create policy images_delete on storage.objects for delete to authenticated using (bucket_id = 'images' and public.can_write());
