create table if not exists public.longword_rooms (
  id text primary key,
  name text not null,
  visibility text not null check (visibility in ('public', 'private')),
  phase text not null default 'lobby' check (phase in ('lobby', 'playing', 'results')),
  round integer not null default 0,
  total_rounds integer not null check (total_rounds between 1 and 20),
  round_seconds integer not null check (round_seconds between 15 and 300),
  scoring text not null check (scoring in ('letters', 'placement')),
  target text,
  letters text,
  deadline timestamptz,
  dictionary text not null default 'Sample word list',
  host_id uuid not null,
  created_at timestamptz not null default now()
);

create table if not exists public.longword_players (
  room_id text not null references public.longword_rooms(id) on delete cascade,
  id uuid not null,
  token_hash text not null,
  name text not null,
  score integer not null default 0,
  online boolean not null default true,
  joined_at timestamptz not null default now(),
  primary key (room_id, id)
);

create table if not exists public.longword_submissions (
  room_id text not null,
  player_id uuid not null,
  word text not null,
  dictionary_source text not null,
  submitted_at timestamptz not null default now(),
  points integer not null default 0,
  rank integer,
  primary key (room_id, player_id),
  foreign key (room_id, player_id)
    references public.longword_players(room_id, id) on delete cascade
);

create index if not exists longword_rooms_open_idx
  on public.longword_rooms (visibility, phase, created_at desc);

alter table public.longword_rooms enable row level security;
alter table public.longword_players enable row level security;
alter table public.longword_submissions enable row level security;

revoke all on public.longword_rooms, public.longword_players, public.longword_submissions from anon, authenticated;
grant all on public.longword_rooms, public.longword_players, public.longword_submissions to service_role;

create or replace function public.longword_start_round(
  room_code text,
  requesting_player uuid,
  round_word text,
  letter_rack text,
  source_name text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare r public.longword_rooms%rowtype;
begin
  select * into r from public.longword_rooms where id = room_code for update;
  if not found then raise exception 'Room not found.'; end if;
  if r.host_id <> requesting_player then raise exception 'Only the host can start a round.'; end if;
  if r.phase = 'playing' then raise exception 'The round is still in progress.'; end if;
  if r.round >= r.total_rounds then raise exception 'All rounds have been played.'; end if;

  update public.longword_rooms
     set phase = 'playing', round = r.round + 1, target = round_word,
         letters = letter_rack, deadline = now() + make_interval(secs => r.round_seconds),
         dictionary = source_name
   where id = room_code;
  delete from public.longword_submissions where room_id = room_code;
  return true;
end;
$$;

create or replace function public.longword_submit(
  room_code text,
  requesting_player uuid,
  submitted_word text,
  source_name text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare r public.longword_rooms%rowtype; remaining_letters text; i integer;
begin
  select * into r from public.longword_rooms where id = room_code for update;
  if not found or r.phase <> 'playing' or r.deadline <= now() then
    raise exception 'This round is closed.';
  end if;
  if not exists (select 1 from public.longword_players where room_id = room_code and id = requesting_player) then
    raise exception 'Join this room first.';
  end if;
  remaining_letters := lower(r.letters);
  if submitted_word !~ '^[a-z]{8,32}$' then raise exception 'Enter a word with at least 8 letters.'; end if;
  for i in 1..char_length(submitted_word) loop
    if position(substring(submitted_word from i for 1) in remaining_letters) = 0 then
      raise exception 'That word cannot be made from these letters.';
    end if;
    remaining_letters := overlay(remaining_letters placing '' from position(substring(submitted_word from i for 1) in remaining_letters) for 1);
  end loop;
  insert into public.longword_submissions(room_id, player_id, word, dictionary_source)
  values (room_code, requesting_player, submitted_word, source_name);
  return true;
end;
$$;

create or replace function public.longword_finish_round(room_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare r public.longword_rooms%rowtype;
begin
  select * into r from public.longword_rooms where id = room_code for update;
  if not found or r.phase <> 'playing' then return false; end if;
  if r.deadline > now() then return false; end if;

  with ranked as (
    select player_id, row_number() over (order by char_length(word) desc, submitted_at asc) as place
    from public.longword_submissions where longword_submissions.room_id = room_code
  )
  update public.longword_submissions s
     set rank = ranked.place,
         points = case
           when r.scoring = 'letters' then char_length(s.word)
           when ranked.place = 1 then 3
           when ranked.place = 2 then 2
           when ranked.place = 3 then 1
           else 0
         end
    from ranked where s.room_id = room_code and s.player_id = ranked.player_id;

  update public.longword_players p
     set score = p.score + s.points
    from public.longword_submissions s
   where s.room_id = room_code and s.player_id = p.id and p.room_id = room_code;
  update public.longword_rooms set phase = 'results', deadline = null where id = room_code;
  return true;
end;
$$;

revoke all on function public.longword_start_round(text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.longword_submit(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.longword_finish_round(text) from public, anon, authenticated;
grant execute on function public.longword_start_round(text, uuid, text, text, text) to service_role;
grant execute on function public.longword_submit(text, uuid, text, text) to service_role;
grant execute on function public.longword_finish_round(text) to service_role;
