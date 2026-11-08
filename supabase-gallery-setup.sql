-- Bezpieczna konfiguracja publicznej galerii Rycerstwa Niepokalanej.
-- Projekt używa public.gallery_photos.id typu bigint (identity).
-- Operacje publikowania/usuwania wykonuje Edge Function:
-- supabase/functions/gallery-manage/index.ts
--
-- Ten skrypt można uruchomić ponownie. Nie usuwa zdjęć ani metadanych galerii.

-- Prywatne powiązanie zdjęcia z hashem tokenu autora.
create table if not exists public.gallery_photo_owners (
  photo_id bigint primary key
    references public.gallery_photos(id) on delete cascade,
  owner_token_hash text not null,
  created_at timestamptz not null default now()
);

alter table public.gallery_photo_owners enable row level security;
revoke all on table public.gallery_photo_owners from public, anon, authenticated;
grant all on table public.gallery_photo_owners to service_role;

drop policy if exists "No browser access to gallery photo owners"
  on public.gallery_photo_owners;
create policy "No browser access to gallery photo owners"
  on public.gallery_photo_owners
  for all to anon, authenticated
  using (false) with check (false);

-- Przeglądanie metadanych galerii jest publiczne. Zapis wyłącznie przez Edge Function.
alter table public.gallery_photos enable row level security;
revoke insert, update, delete, truncate, references, trigger
  on table public.gallery_photos from anon, authenticated;
grant select on table public.gallery_photos to anon, authenticated;

drop policy if exists "Anyone can add gallery photos" on public.gallery_photos;
drop policy if exists "Anyone can add gallery photo" on public.gallery_photos;
drop policy if exists "Anyone can view gallery" on public.gallery_photos;
drop policy if exists "Gallery photos are viewable by everyone" on public.gallery_photos;
create policy "Gallery photos are viewable by everyone"
  on public.gallery_photos
  for select to anon, authenticated
  using (true);

-- Publiczny bucket do wyświetlania zdjęć, ale upload ograniczony do obrazów 2 MB.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'gallery',
  'gallery',
  true,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public can upload gallery files" on storage.objects;
drop policy if exists "Anyone can upload gallery photos" on storage.objects;
create policy "Public can upload gallery files"
  on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'gallery'
    and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$'
  );

drop policy if exists "Public can view gallery files" on storage.objects;
create policy "Public can view gallery files"
  on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'gallery');

-- Edge Function korzysta z SUPABASE_SERVICE_ROLE_KEY wyłącznie po stronie serwera.
-- Nie umieszczaj service_role/secret key w index.html ani w repozytorium.
