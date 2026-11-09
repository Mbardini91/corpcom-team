-- =====================================================================
--  مجلة «أضواء» التفاعلية — الإحصائيات والإعجابات (Supabase)
--  المجلة عامة (بدون تسجيل دخول)، لذلك:
--   • لا يكتب القرّاء في الجداول مباشرة؛ كل شيء يمر عبر الدوال
--     adwaa_track و adwaa_like، وهي تتحقق من الصيغة وتحدّ من التكرار.
--   • لا تُجمع أي بيانات شخصية: لا اسم ولا إيميل ولا IP.
--     القارئ يُعرَّف برقم عشوائي يُنشأ على جهازه فقط (لعدّ الزوار والإعجاب مرة واحدة).
--   • عدّاد الإعجابات العام يأتي من adwaa_like_state (الأرقام فقط).
--   • الإحصائيات التفصيلية يقرأها أعضاء الفريق فقط من المنصة (adwaa_stats).
-- =====================================================================

-- الأعداد ومواضيعها (يُسجَّل العدد تلقائياً أول ما تُفتح المجلة، ويقدر المسؤول يعدّله)
create table if not exists public.adwaa_issues (
  id         text primary key check (id ~ '^[a-z0-9-]{1,32}$'),
  number     integer,
  label      text,
  pages      integer,
  topics     jsonb not null default '[]'::jsonb,       -- [{id, s, e, t}]
  created_at timestamptz not null default now()
);

-- أحداث القراءة
create table if not exists public.adwaa_events (
  id         bigint generated always as identity primary key,
  issue_id   text not null,
  visitor    uuid not null,                            -- رقم عشوائي محفوظ على جهاز القارئ
  session    uuid not null,                            -- جلسة القراءة
  type       text not null check (type in ('open','page','topic','time','share','capture','like','unlike','download','listen','search','link','game','install')),
  topic      text,
  page       smallint,
  channel    text,                                     -- قناة المشاركة / نوع الاقتباس / رابط خارجي
  q          text,                                     -- كلمة البحث
  value      integer,                                  -- ثوانٍ
  source     text,                                     -- من وين وصل (لحدث open فقط)
  device     text,                                     -- mobile / tablet / desktop
  is_return  boolean,                                  -- زائر سبق له فتح المجلة
  created_at timestamptz not null default now()
);
create index if not exists adwaa_events_issue   on public.adwaa_events (issue_id, created_at desc);
create index if not exists adwaa_events_type    on public.adwaa_events (type, issue_id);
create index if not exists adwaa_events_session on public.adwaa_events (session, created_at desc);

-- الإعجابات: قارئ واحد = إعجاب واحد لكل موضوع
create table if not exists public.adwaa_likes (
  issue_id   text not null,
  topic      text not null,
  visitor    uuid not null,
  created_at timestamptz not null default now(),
  primary key (issue_id, topic, visitor)
);

alter table public.adwaa_issues enable row level security;
alter table public.adwaa_events enable row level security;
alter table public.adwaa_likes  enable row level security;

drop policy if exists adwaa_issues_team_read on public.adwaa_issues;
drop policy if exists adwaa_issues_admin_upd on public.adwaa_issues;
drop policy if exists adwaa_events_team_read on public.adwaa_events;
drop policy if exists adwaa_likes_team_read  on public.adwaa_likes;
create policy adwaa_issues_team_read on public.adwaa_issues for select to authenticated using (public.is_member());
create policy adwaa_issues_admin_upd on public.adwaa_issues for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy adwaa_events_team_read on public.adwaa_events for select to authenticated using (public.is_member());
create policy adwaa_likes_team_read  on public.adwaa_likes  for select to authenticated using (public.is_member());

-- ---------------------------------------------------------------------
-- تسجيل دفعة أحداث من المجلة
-- p_events: [{t, tp, p, c, q, v, src, dev, ret}]
-- p_meta (مع أول دفعة): {number, label, pages, topics:[{id,s,e,t}]}
-- ---------------------------------------------------------------------
create or replace function public.adwaa_track(
  p_issue text, p_visitor uuid, p_session uuid, p_events jsonb, p_meta jsonb default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  e jsonb; t text;
  v_src text; v_dev text;
begin
  if coalesce(p_issue,'') !~ '^[a-z0-9-]{1,32}$' or p_visitor is null or p_session is null then raise exception 'bad_request'; end if;
  if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events) > 80 then raise exception 'bad_request'; end if;
  -- حدّ معقول: 600 حدث بالدقيقة للجلسة الواحدة
  if (select count(*) from public.adwaa_events where session = p_session and created_at > now() - interval '1 minute') > 600 then return; end if;

  if p_meta is not null and jsonb_typeof(p_meta->'topics') = 'array' then
    insert into public.adwaa_issues (id, number, label, pages, topics)
    select p_issue,
           case when (p_meta->>'number') ~ '^\d{1,4}$' then (p_meta->>'number')::int end,
           left(regexp_replace(coalesce(p_meta->>'label',''), '[[:cntrl:]<>]', '', 'g'), 80),
           case when (p_meta->>'pages') ~ '^\d{1,3}$' then (p_meta->>'pages')::int end,
           coalesce((select jsonb_agg(jsonb_build_object(
                       'id', x->>'id', 's', (x->>'s')::int, 'e', (x->>'e')::int,
                       't', left(regexp_replace(coalesce(x->>'t',''), '[[:cntrl:]<>]', '', 'g'), 120)))
                     from (select x from jsonb_array_elements(p_meta->'topics') x limit 80) q
                     where x->>'id' ~ '^[a-z0-9-]{1,32}$' and (x->>'s') ~ '^\d{1,3}$' and (x->>'e') ~ '^\d{1,3}$'), '[]'::jsonb)
    on conflict (id) do nothing;
  end if;

  for e in select * from jsonb_array_elements(p_events) loop
    t := e->>'t';
    if t is null or t not in ('open','page','topic','time','share','capture','download','listen','search','link','game','install') then continue; end if;
    v_src := null; v_dev := null;
    if t = 'open' then
      if exists (select 1 from public.adwaa_events where session = p_session and type = 'open') then continue; end if;
      v_src := case when e->>'src' ~ '^[a-z0-9-]{1,24}$' then e->>'src' else 'direct' end;
      v_dev := case when e->>'dev' in ('mobile','tablet','desktop') then e->>'dev' end;
    end if;
    insert into public.adwaa_events (issue_id, visitor, session, type, topic, page, channel, q, value, source, device, is_return)
    values (p_issue, p_visitor, p_session, t,
      case when e->>'tp' ~ '^[a-z0-9-]{1,32}$' then e->>'tp' end,
      case when (e->>'p') ~ '^\d{1,3}$' then (e->>'p')::smallint end,
      case when e->>'c' ~ '^[a-z0-9_.:-]{1,60}$' then e->>'c' end,
      case when t = 'search' then nullif(left(regexp_replace(trim(coalesce(e->>'q','')), '[[:cntrl:]<>]', '', 'g'), 60), '') end,
      case when (e->>'v') ~ '^\d{1,6}$' then least((e->>'v')::int, 36000) end,
      v_src, v_dev,
      case when t = 'open' then coalesce((e->>'ret')::boolean, false) end);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- الإعجاب / إلغاء الإعجاب — يرجّع العدد الجديد
-- ---------------------------------------------------------------------
create or replace function public.adwaa_like(
  p_issue text, p_topic text, p_visitor uuid, p_session uuid, p_liked boolean
) returns integer
language plpgsql security definer set search_path = public as $$
declare rc integer := 0;
begin
  if coalesce(p_issue,'') !~ '^[a-z0-9-]{1,32}$' or coalesce(p_topic,'') !~ '^[a-z0-9-]{1,32}$' or p_visitor is null then raise exception 'bad_request'; end if;
  if (select count(*) from public.adwaa_events where visitor = p_visitor and type in ('like','unlike') and created_at > now() - interval '10 seconds') >= 12 then
    raise exception 'too_fast';
  end if;
  if p_liked then
    insert into public.adwaa_likes (issue_id, topic, visitor) values (p_issue, p_topic, p_visitor) on conflict do nothing;
  else
    delete from public.adwaa_likes where issue_id = p_issue and topic = p_topic and visitor = p_visitor;
  end if;
  get diagnostics rc = row_count;
  if rc > 0 then
    insert into public.adwaa_events (issue_id, visitor, session, type, topic)
    values (p_issue, p_visitor, coalesce(p_session, p_visitor), case when p_liked then 'like' else 'unlike' end, p_topic);
  end if;
  return (select count(*) from public.adwaa_likes where issue_id = p_issue and topic = p_topic);
end $$;

-- عدّاد الإعجابات العام لكل مواضيع العدد + هل القارئ معجب
create or replace function public.adwaa_like_state(p_issue text, p_visitor uuid default null)
returns table(topic text, n bigint, mine boolean)
language sql stable security definer set search_path = public as $$
  select l.topic, count(*), coalesce(bool_or(l.visitor = p_visitor), false)
  from public.adwaa_likes l where l.issue_id = p_issue group by l.topic
$$;

-- ---------------------------------------------------------------------
-- الإحصائيات الكاملة للمنصة (أعضاء الفريق فقط)
-- p_issue: معرّف العدد أو null لكل الأعداد · p_year: سنة أو null
-- ---------------------------------------------------------------------
create or replace function public.adwaa_stats(p_issue text default null, p_year integer default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not public.is_member() then raise exception 'forbidden'; end if;

  with ev as (
    select e.*, (e.created_at at time zone 'Asia/Bahrain') as lt
    from public.adwaa_events e
    where (p_issue is null or e.issue_id = p_issue)
      and (p_year is null or extract(year from e.created_at at time zone 'Asia/Bahrain') = p_year)
  ),
  sess as (select session, issue_id, visitor, source, device, is_return, lt from ev where type = 'open'),
  stime as (select session, max(value) as secs from ev where type = 'time' group by session),
  smax as (select session, issue_id, max(page) as mp, count(distinct page) as np from ev where type = 'page' group by session, issue_id),
  lk as (
    select l.* from public.adwaa_likes l
    where (p_issue is null or l.issue_id = p_issue)
      and (p_year is null or extract(year from l.created_at at time zone 'Asia/Bahrain') = p_year)
  ),
  tdw as (select issue_id, topic, session, sum(coalesce(value,0)) as secs from ev where type = 'topic' and topic is not null group by issue_id, topic, session),
  tcat as (
    select i.id as issue_id, i.label, x->>'id' as topic, x->>'t' as title, (x->>'s')::int as s, (x->>'e')::int as e
    from public.adwaa_issues i, jsonb_array_elements(i.topics) x
    where p_issue is null or i.id = p_issue
  ),
  tkeys as (
    select issue_id, topic from tcat
    union select issue_id, topic from tdw
    union select issue_id, topic from lk
  ),
  tstat as (
    select k.issue_id, k.topic, c.title, c.label, c.s, c.e,
      (select count(*) from tdw d where d.issue_id = k.issue_id and d.topic = k.topic) as views,
      (select count(*) from tdw d where d.issue_id = k.issue_id and d.topic = k.topic and d.secs >= 15) as reads,
      (select coalesce(sum(d.secs),0) from tdw d where d.issue_id = k.issue_id and d.topic = k.topic) as secs,
      (select count(*) from lk l where l.issue_id = k.issue_id and l.topic = k.topic) as likes,
      (select count(*) from ev x where x.type = 'share' and x.issue_id = k.issue_id and x.topic = k.topic) as shares,
      (select count(*) from ev x where x.type = 'capture' and x.channel = 'create' and x.issue_id = k.issue_id and x.topic = k.topic) as captures
    from tkeys k left join tcat c on c.issue_id = k.issue_id and c.topic = k.topic
  )
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'sessions',      (select count(*) from sess),
      'visitors',      (select count(distinct visitor) from sess),
      'returning',     (select count(distinct visitor) from sess where is_return),
      'today',         (select count(*) from sess where lt::date = (now() at time zone 'Asia/Bahrain')::date),
      'page_views',    (select count(*) from ev where type = 'page'),
      'avg_pages',     (select round(avg(np)::numeric, 1) from smax),
      'avg_secs',      (select round(avg(least(secs, 10800))) from stime where secs > 0),
      'median_secs',   (select round(percentile_cont(0.5) within group (order by least(secs, 10800)))::int from stime where secs > 0),
      'total_mins',    (select round(sum(least(secs, 10800)) / 60.0) from stime),
      'completed',     (select count(*) from smax m join public.adwaa_issues i on i.id = m.issue_id where i.pages is not null and m.mp >= i.pages - 1),
      'bounced',       (select count(*) from sess s where coalesce((select np from smax m where m.session = s.session), 0) <= 2),
      'downloads',     (select count(*) from ev where type = 'download'),
      'shares',        (select count(*) from ev where type = 'share'),
      'captures',      (select count(*) from ev where type = 'capture' and channel = 'create'),
      'capture_users', (select count(distinct session) from ev where type = 'capture' and channel = 'create'),
      'capture_out',   (select count(*) from ev where type = 'capture' and channel in ('save','copy','share')),
      'likes',         (select count(*) from lk),
      'likers',        (select count(distinct visitor) from lk),
      'listeners',     (select count(distinct session) from ev where type = 'listen'),
      'listen_mins',   (select round(coalesce(sum(value),0) / 60.0) from ev where type = 'listen'),
      'searches',      (select count(*) from ev where type = 'search'),
      'links',         (select count(*) from ev where type = 'link'),
      'games',         (select count(*) from ev where type = 'game'),
      'installs',      (select count(*) from ev where type = 'install')
    ),
    'topics',   coalesce((select jsonb_agg(jsonb_build_object('issue', issue_id, 'label', label, 'id', topic, 't', coalesce(title, topic), 's', s, 'e', e,
                  'views', views, 'reads', reads, 'secs', secs, 'likes', likes, 'shares', shares, 'captures', captures) order by reads desc, views desc, s) from tstat), '[]'::jsonb),
    'sources',  coalesce((select jsonb_agg(jsonb_build_object('k', k, 'n', n) order by n desc) from (select coalesce(source,'direct') k, count(*) n from sess group by 1) q), '[]'::jsonb),
    'devices',  coalesce((select jsonb_agg(jsonb_build_object('k', k, 'n', n) order by n desc) from (select coalesce(device,'desktop') k, count(*) n from sess group by 1) q), '[]'::jsonb),
    'share_ch', coalesce((select jsonb_agg(jsonb_build_object('k', k, 'n', n) order by n desc) from (select coalesce(channel,'other') k, count(*) n from ev where type = 'share' group by 1) q), '[]'::jsonb),
    'capture_ch', coalesce((select jsonb_agg(jsonb_build_object('k', k, 'n', n) order by n desc) from (select channel k, count(*) n from ev where type = 'capture' and channel in ('save','copy','share') group by 1) q), '[]'::jsonb),
    'days',     coalesce((select jsonb_agg(jsonb_build_object('d', d, 'n', n) order by d) from (select to_char(lt, 'YYYY-MM-DD') d, count(*) n from sess group by 1) q), '[]'::jsonb),
    'hours',    coalesce((select jsonb_agg(jsonb_build_object('h', h, 'n', n) order by h) from (select extract(hour from lt)::int h, count(*) n from sess group by 1) q), '[]'::jsonb),
    'pages',    coalesce((select jsonb_agg(jsonb_build_object('p', p, 'n', n) order by p) from (select page p, count(distinct session) n from ev where type = 'page' and page is not null group by 1) q), '[]'::jsonb),
    'search',   coalesce((select jsonb_agg(jsonb_build_object('k', k, 'n', n) order by n desc) from (select lower(q) k, count(*) n from ev where type = 'search' and q is not null group by 1 order by 2 desc limit 15) q), '[]'::jsonb),
    'links',    coalesce((select jsonb_agg(jsonb_build_object('k', k, 'n', n) order by n desc) from (select channel k, count(*) n from ev where type = 'link' and channel is not null group by 1 order by 2 desc limit 10) q), '[]'::jsonb),
    'issues',   coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'label', i.label, 'number', i.number, 'pages', i.pages,
                  'sessions', (select count(*) from public.adwaa_events e where e.issue_id = i.id and e.type = 'open')) order by i.number desc nulls last, i.created_at desc)
                 from public.adwaa_issues i), '[]'::jsonb),
    'years',    coalesce((select jsonb_agg(y order by y) from (select distinct extract(year from created_at at time zone 'Asia/Bahrain')::int y from public.adwaa_events) q), '[]'::jsonb)
  ) into r;
  return r;
end $$;

revoke all on function public.adwaa_track(text,uuid,uuid,jsonb,jsonb) from public;
revoke all on function public.adwaa_like(text,text,uuid,uuid,boolean) from public;
revoke all on function public.adwaa_like_state(text,uuid) from public;
revoke all on function public.adwaa_stats(text,integer) from public, anon;
grant execute on function public.adwaa_track(text,uuid,uuid,jsonb,jsonb) to anon, authenticated;
grant execute on function public.adwaa_like(text,text,uuid,uuid,boolean) to anon, authenticated;
grant execute on function public.adwaa_like_state(text,uuid) to anon, authenticated;
grant execute on function public.adwaa_stats(text,integer) to authenticated;

-- تحديث لحظي لتبويب «أضواء» في المنصة (عند فتح أي قارئ للمجلة)
do $$ begin
  alter publication supabase_realtime add table public.adwaa_events;
exception when duplicate_object then null; end $$;

-- العدد الحالي (10 · الربع الثاني 2026)
insert into public.adwaa_issues (id, number, label, pages, topics) values ('2026-q2', 10, 'العدد 10 · الربع الثاني 2026', 58, '[{"id": "ceo-word", "s": 3, "e": 3, "t": "تطوير لا يتوقف"}, {"id": "events", "s": 4, "e": 6, "t": "أبرز الفعاليات والمستجدات"}, {"id": "departments", "s": 7, "e": 7, "t": "إدارات"}, {"id": "outstanding", "s": 8, "e": 12, "t": "متميزون"}, {"id": "twin-fame", "s": 13, "e": 13, "t": "توأم الشهرة"}, {"id": "inspiring", "s": 14, "e": 19, "t": "ملهمون ومبتكرون · سعود يتيم"}, {"id": "spotlight", "s": 20, "e": 23, "t": "Spotlight on · فاطمة الظاعن"}, {"id": "here-there", "s": 24, "e": 37, "t": "من هنا وهناك"}, {"id": "zanzibar", "s": 38, "e": 43, "t": "زنجبار.. حيث يصنع العطاء أجمل الرحلات"}, {"id": "severance", "s": 44, "e": 45, "t": "مراجعة مسلسل Severance"}, {"id": "calendar", "s": 46, "e": 47, "t": "التقويم الشهري"}, {"id": "memories", "s": 48, "e": 49, "t": "صور من ذاكرة الهيئة"}, {"id": "our-table", "s": 50, "e": 51, "t": "على سفرتنا.. رحلة بحرية"}, {"id": "legal", "s": 52, "e": 52, "t": "إضاءات قانونية"}, {"id": "positive", "s": 53, "e": 53, "t": "ومضة إيجابية"}, {"id": "values-game", "s": 54, "e": 55, "t": "لعبة رحلة القيم"}, {"id": "channels", "s": 56, "e": 57, "t": "قنوات التواصل والمشاركة"}]'::jsonb)
on conflict (id) do update set number = excluded.number, label = excluded.label, pages = excluded.pages, topics = excluded.topics;
