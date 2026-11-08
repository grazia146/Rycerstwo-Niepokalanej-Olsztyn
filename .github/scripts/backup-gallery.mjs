import fs from "node:fs/promises";
import path from "node:path";

const SUPABASE_URL = "https://vmrcvypdaiubowgxvdwm.supabase.co";
const SUPABASE_KEY = "sb_publishable_pj6zzQNcL3M4M1sJz0PZhg_eyIUH6UL";
const BUCKET = "gallery";
const OUT = "backup/gallery/current";
const PAGE_SIZE = 500;

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase request failed (${response.status}): ${body.slice(0, 500)}`);
  }
  return response;
}

async function getAllPhotos() {
  const all = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = new URL(`${SUPABASE_URL}/rest/v1/gallery_photos`);
    url.searchParams.set("select", "id,caption,storage_path,created_at");
    url.searchParams.set("order", "created_at.asc");
    const response = await api(url, {
      headers: { Range: `${offset}-${offset + PAGE_SIZE - 1}` }
    });
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error("Nieoczekiwany format metadanych galerii.");
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return all;
}

async function downloadPhoto(storagePath) {
  if (typeof storagePath !== "string" || storagePath.includes("..") || storagePath.startsWith("/")) {
    throw new Error("Nieprawidłowa ścieżka zdjęcia w galerii.");
  }
  const encodedPath = storagePath.split("/").map(encodeURIComponent).join("/");
  const url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${encodedPath}`;
  const response = await api(url);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 2 * 1024 * 1024) throw new Error(`Zdjęcie przekracza limit 2 MB: ${storagePath}`);
  const destination = path.join(OUT, "photos", ...storagePath.split("/"));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, bytes);
  return { path: storagePath, bytes: bytes.length };
}

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(path.join(OUT, "photos"), { recursive: true });

const photos = await getAllPhotos();
const downloaded = [];
for (let i = 0; i < photos.length; i += 5) {
  const batch = photos.slice(i, i + 5);
  downloaded.push(...await Promise.all(batch.map(photo => downloadPhoto(photo.storage_path))));
}

await fs.writeFile(
  path.join(OUT, "metadata.json"),
  JSON.stringify({
    backup_created_at: new Date().toISOString(),
    project: "Rycerstwo Niepokalanej Olsztyn",
    bucket: BUCKET,
    photo_count: photos.length,
    photos
  }, null, 2) + "\n"
);

await fs.writeFile(
  path.join(OUT, "README.txt"),
  "Kopia galerii Rycerstwa Niepokalanej w Olsztynie.\n" +
  "metadata.json zawiera podpisy, identyfikatory i ścieżki zdjęć.\n" +
  "photos/ zawiera pobrane oryginalne pliki.\n" +
  "Kopia jest aktualizowana automatycznie raz w tygodniu.\n"
);

const totalBytes = downloaded.reduce((sum, item) => sum + item.bytes, 0);
console.log(`Backup zakończony: ${photos.length} zdjęć, ${totalBytes} bajtów.`);
