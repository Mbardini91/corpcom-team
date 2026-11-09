-- =====================================================================
--  لعبة «رحلة القيم» — جداول النتائج والإحصائيات (Supabase)
--  اللعبة عامة (بدون تسجيل دخول)، لذلك:
--   • لا يكتب الزوار في الجداول مباشرة؛ الإرسال يمر عبر الدالة submit_game_run فقط،
--     وهي تتحقق من منطقية النتيجة وتحفظ أفضل نتيجة لكل لاعب.
--   • لوحة المتصدرين العامة تأتي من الدالة game_leaderboard (الاسم والنقاط فقط).
--   • الإحصائيات التفصيلية (كل الجولات) يقرأها أعضاء الفريق فقط من المنصة.
-- =====================================================================

create table if not exists public.game_players (
  player_id   uuid primary key,                          -- معرّف عشوائي يُنشأ على جهاز اللاعب
  name        text not null check (char_length(name) between 2 and 28),
  avatar      text not null default 'm' check (avatar in ('m','f')),
  best_score  integer not null default 0,
  best_values integer not null default 0,
  best_gates  integer not null default 0,
  plays       integer not null default 0,
  first_at    timestamptz not null default now(),
  last_at     timestamptz not null default now(),
  best_at     timestamptz
);
create index if not exists game_players_rank on public.game_players (best_score desc, best_at asc);

create table if not exists public.game_runs (
  id          bigint generated always as identity primary key,
  player_id   uuid not null references public.game_players(player_id) on delete cascade,
  score       integer not null,
  values_n    integer not null,
  gates       integer not null,
  combos      integer not null default 0,
  stage       integer not null default 1,
  duration_s  integer not null default 0,
  source      text not null default 'direct' check (source in ('magazine','app','direct')),
  created_at  timestamptz not null default now()
);
create index if not exists game_runs_created on public.game_runs (created_at desc);
create index if not exists game_runs_player  on public.game_runs (player_id, created_at desc);

alter table public.game_players enable row level security;
alter table public.game_runs    enable row level security;

-- أعضاء الفريق فقط يقرؤون التفاصيل (للإحصائيات في المنصة)؛ لا كتابة مباشرة لأي أحد
drop policy if exists game_players_team_read on public.game_players;
drop policy if exists game_runs_team_read    on public.game_runs;
create policy game_players_team_read on public.game_players for select to authenticated using (public.is_member());
create policy game_runs_team_read    on public.game_runs    for select to authenticated using (public.is_member());
drop policy if exists game_players_admin_del on public.game_players;
create policy game_players_admin_del on public.game_players for delete to authenticated using (public.is_admin());

-- إرسال جولة منتهية
create or replace function public.submit_game_run(
  p_player uuid, p_name text, p_avatar text,
  p_score integer, p_values integer, p_gates integer, p_combos integer,
  p_stage integer, p_duration integer, p_source text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name text := left(regexp_replace(trim(coalesce(p_name,'')), '[[:cntrl:]<>]', '', 'g'), 28);
  v_prev public.game_players%rowtype;
  v_best integer;
begin
  if p_player is null then raise exception 'player_required'; end if;
  if char_length(v_name) < 2 then raise exception 'name_invalid'; end if;
  if coalesce(p_avatar,'') not in ('m','f') then raise exception 'avatar_invalid'; end if;
  if p_score < 0 or p_values < 0 or p_gates < 0 or p_combos < 0 or p_duration < 0 then raise exception 'score_invalid'; end if;
  -- منطق اللعبة: قيمة = 10، عمود = 1، اكتمال القيم الخمس = 25
  if p_score <> p_values * 10 + p_gates + p_combos * 25 then raise exception 'score_mismatch'; end if;
  if p_values > p_gates + 2 or p_combos > p_values / 5 then raise exception 'score_out_of_range'; end if;
  if p_duration > 3600 or p_gates > p_duration * 1.3 + 3 then raise exception 'score_out_of_range'; end if;
  if coalesce(p_source,'direct') not in ('magazine','app','direct') then p_source := 'direct'; end if;

  select * into v_prev from public.game_players where player_id = p_player;
  if found and v_prev.last_at > now() - interval '2 seconds' then raise exception 'too_fast'; end if;

  insert into public.game_players as g (player_id, name, avatar, best_score, best_values, best_gates, plays, best_at)
  values (p_player, v_name, p_avatar, p_score, p_values, p_gates, 1, now())
  on conflict (player_id) do update set
    name        = excluded.name,
    avatar      = excluded.avatar,
    plays       = g.plays + 1,
    last_at     = now(),
    best_score  = greatest(g.best_score, excluded.best_score),
    best_values = case when excluded.best_score > g.best_score then excluded.best_values else g.best_values end,
    best_gates  = case when excluded.best_score > g.best_score then excluded.best_gates  else g.best_gates  end,
    best_at     = case when excluded.best_score > g.best_score then now() else g.best_at end;

  insert into public.game_runs (player_id, score, values_n, gates, combos, stage, duration_s, source)
  values (p_player, p_score, p_values, p_gates, p_combos, greatest(1, least(p_stage, 9)), p_duration, coalesce(p_source,'direct'));

  select best_score into v_best from public.game_players where player_id = p_player;
  return jsonb_build_object(
    'best', v_best,
    'improved', v_prev.player_id is null or p_score > v_prev.best_score,
    'rank', (select count(*) + 1 from public.game_players where best_score > v_best),
    'total', (select count(*) from public.game_players)
  );
end $$;

-- لوحة المتصدرين العامة: الاسم والشخصية والنقاط، مع وسم قصير يتيح للاعب تمييز نفسه
create or replace function public.game_leaderboard(p_limit integer default 100)
returns table(rank bigint, tag text, name text, avatar text, score integer, at timestamptz, total bigint)
language sql stable security definer set search_path = public as $$
  select row_number() over (order by best_score desc, best_at asc) as rank,
         left(encode(sha256(convert_to(player_id::text, 'UTF8')), 'hex'), 12) as tag,
         name, avatar, best_score, best_at,
         count(*) over () as total
  from public.game_players
  where best_score > 0
  order by best_score desc, best_at asc
  limit least(greatest(coalesce(p_limit, 100), 1), 500)
$$;

revoke all on function public.submit_game_run(uuid,text,text,integer,integer,integer,integer,integer,integer,text) from public;
revoke all on function public.game_leaderboard(integer) from public;
grant execute on function public.submit_game_run(uuid,text,text,integer,integer,integer,integer,integer,integer,text) to anon, authenticated;
grant execute on function public.game_leaderboard(integer) to anon, authenticated;

-- تحديث لحظي لتبويب الإحصائيات في المنصة
do $$ begin
  alter publication supabase_realtime add table public.game_runs;
exception when duplicate_object then null; end $$;
