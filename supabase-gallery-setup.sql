-- Konfiguracja publicznej galerii Rycerstwa Niepokalanej
-- Uruchom caly plik w Supabase: SQL Editor -> New query -> Run.
-- Zaklada, ze gallery_photos.id ma typ uuid, a tabela ma kolumny:
-- id, caption, storage_path, created_at.

create extension if not exists pgcrypto with schema extensions;

-- Prywatna tabela: tokenow wlascicieli nie udostepniamy publicznie.
create table if not exists public.gallery_photo_owners (
  photo_id uuid primary key references public.gallery_photos(id) on delete cascade,
  owner_token_hash text not null,
  created_at timestamptz not null default now()
);

alter table public.gallery_photo_owners enable row level security;

-- Funkcja publikuje metadane i zapisuje jedynie hash tokenu autora.
create or replace function public.publish_gallery_photo(
  p_caption text,
  p_storage_path text,
  p_owner_token text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_photo_id uuid;
begin
  if p_caption is null or length(trim(p_caption)) = 0 or length(p_caption) > 100 then
    raise exception 'Invalid caption';
  end if;
  if p_storage_path is null or p_storage_path !~ '^[0-9a-fA-F-]{36}\.(jpg|png|webp)$' then
    raise exception 'Invalid storage path';
  end if;
  if p_owner_token is null or length(p_owner_token) < 32 or length(p_owner_token) > 200 then
    raise exception 'Invalid owner token';
  end if;

  insert into public.gallery_photos (caption, storage_path)
  values (trim(p_caption), p_storage_path)
  returning id into new_photo_id;

  insert into public.gallery_photo_owners (photo_id, owner_token_hash)
  values (new_photo_id, encode(extensions.digest(p_owner_token, 'sha256'), 'hex'));

  return new_photo_id;
end;
$$;

-- Usuwa zdjecie tylko po okazaniu sekretnego tokenu zapisanego
-- na urzadzeniu, z ktorego zdjecie zostalo dodane.
create or replace function public.delete_gallery_photo(
  p_photo_id text,
  p_owner_token text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  photo_uuid uuid;
  photo_path text;
  expected_hash text;
begin
  begin
    photo_uuid := p_photo_id::uuid;
  exception when others then
    return false;
  end;

  select o.owner_token_hash, p.storage_path
    into expected_hash, photo_path
  from public.gallery_photo_owners o
  join public.gallery_photos p on p.id = o.photo_id
  where o.photo_id = photo_uuid;

  if expected_hash is null or p_owner_token is null
     or expected_hash <> encode(extensions.digest(p_owner_token, 'sha256'), 'hex') then
    return false;
  end if;

  delete from storage.objects
  where bucket_id = 'gallery' and name = photo_path;

  delete from public.gallery_photos where id = photo_uuid;
  return true;
end;
$$;

revoke all on function public.publish_gallery_photo(text, text, text) from public;
revoke all on function public.delete_gallery_photo(text, text) from public;
grant execute on function public.publish_gallery_photo(text, text, text) to anon, authenticated;
grant execute on function public.delete_gallery_photo(text, text) to anon, authenticated;

-- Publiczne przesylanie tylko do bucketu gallery.
-- Bucket jest publiczny do wyswietlania zdjec; zapis nadal podlega polityce.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gallery', 'gallery', true, 2097152, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
set public = true,
    file_size_limit = 2097152,
    allowed_mime_types = excluded.allowed_mime_types;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Anyone can upload gallery photos'
  ) then
    create policy "Anyone can upload gallery photos"
      on storage.objects for insert to anon, authenticated
      with check (bucket_id = 'gallery');
  end if;
end $$;

-- Publiczne odczytywanie podpisow i sciezek zdjec.
alter table public.gallery_photos enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'gallery_photos'
      and policyname = 'Gallery photos are viewable by everyone'
  ) then
    create policy "Gallery photos are viewable by everyone"
      on public.gallery_photos for select to anon, authenticated
      using (true);
  end if;
end $$;
