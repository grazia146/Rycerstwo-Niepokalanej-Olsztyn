import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const legacyServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
let serviceKey = legacyServiceKey;
if (!serviceKey && secretKeysRaw) {
  try { serviceKey = JSON.parse(secretKeysRaw).default; } catch { /* missing configuration handled below */ }
}
const legacyAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
const publishableKeysRaw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
let publishableKey = legacyAnonKey;
if (!publishableKey && publishableKeysRaw) {
  try { publishableKey = JSON.parse(publishableKeysRaw).default; } catch { /* missing configuration handled below */ }
}

const admin = supabaseUrl && serviceKey
  ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);
  if (!admin || !publishableKey) return response({ error: "Server configuration error" }, 500);
  if (req.headers.get("apikey") !== publishableKey) return response({ error: "Unauthorized client" }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return response({ error: "Invalid JSON" }, 400); }

  const action = body.action;
  const token = typeof body.ownerToken === "string" ? body.ownerToken : "";
  if (token.length < 32 || token.length > 200) return response({ error: "Invalid owner token" }, 400);

  try {
    const tokenHash = await sha256(token);

    if (action === "publish") {
      const caption = typeof body.caption === "string" ? body.caption.trim() : "";
      const path = typeof body.storagePath === "string" ? body.storagePath : "";
      if (!caption || caption.length > 100) return response({ error: "Caption must contain 1–100 characters" }, 400);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/i.test(path)) {
        return response({ error: "Invalid storage path" }, 400);
      }

      const { data: file, error: downloadError } = await admin.storage.from("gallery").download(path);
      if (downloadError || !file) return response({ error: "Uploaded photo not found" }, 400);
      if (file.size > 2 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        await admin.storage.from("gallery").remove([path]);
        return response({ error: "Unsupported image or file too large" }, 400);
      }

      const { data: photo, error: photoError } = await admin
        .from("gallery_photos").insert({ caption, storage_path: path }).select("id").single();
      if (photoError || !photo) {
        console.error("Could not insert gallery metadata", photoError);
        return response({ error: "Could not publish photo" }, 500);
      }

      const { error: ownerError } = await admin.from("gallery_photo_owners")
        .insert({ photo_id: photo.id, owner_token_hash: tokenHash });
      if (ownerError) {
        console.error("Could not save photo owner", ownerError);
        await admin.from("gallery_photos").delete().eq("id", photo.id);
        await admin.storage.from("gallery").remove([path]);
        return response({ error: "Could not save photo ownership" }, 500);
      }
      return response({ photoId: photo.id });
    }

    if (action === "delete") {
      const photoId = Number(body.photoId);
      if (!Number.isSafeInteger(photoId) || photoId <= 0) return response({ error: "Invalid photo ID" }, 400);

      const { data: owner, error: ownerError } = await admin.from("gallery_photo_owners")
        .select("owner_token_hash").eq("photo_id", photoId).maybeSingle();
      if (ownerError) {
        console.error("Could not read photo owner", ownerError);
        return response({ error: "Could not verify photo owner" }, 500);
      }
      if (!owner || !constantTimeEqual(owner.owner_token_hash, tokenHash)) return response({ error: "Invalid owner token" }, 403);

      const { data: photo, error: photoError } = await admin.from("gallery_photos")
        .select("storage_path").eq("id", photoId).maybeSingle();
      if (photoError || !photo) return response({ error: "Photo not found" }, 404);

      const { error: storageError } = await admin.storage.from("gallery").remove([photo.storage_path]);
      if (storageError) {
        console.error("Could not remove photo from Storage", storageError);
        return response({ error: "Could not remove photo file" }, 500);
      }
      const { error: deleteError } = await admin.from("gallery_photos").delete().eq("id", photoId);
      if (deleteError) {
        console.error("Could not remove gallery metadata", deleteError);
        return response({ error: "File removed but gallery entry could not be removed" }, 500);
      }
      return response({ deleted: true });
    }
    return response({ error: "Unknown action" }, 400);
  } catch (error) {
    console.error("gallery-manage error", error);
    return response({ error: "Unexpected server error" }, 500);
  }
});
