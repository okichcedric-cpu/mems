import { supabase } from "./supabase";

// ── Marketplace creator profiles ─────────────────────────────────────────
// A "marketplace account" is simply a user with a row in creator_profiles
// (see supabase/migrations/20261028120000_create_creator_profiles.sql).
// Profiles are public to read; each user can only write their own.

export type CreatorProfile = {
  userId: string;
  handle: string;
  displayName: string;
  bio: string;
  status: "active" | "suspended";
};

type Row = {
  user_id: string;
  handle: string;
  display_name: string;
  bio: string;
  status: "active" | "suspended";
};

function fromRow(row: Row): CreatorProfile {
  return {
    userId: row.user_id,
    handle: row.handle,
    displayName: row.display_name,
    bio: row.bio,
    status: row.status,
  };
}

// ── Validation (mirrors the database constraints exactly) ───────────────
// Kept in sync with the CHECK constraints in the migration, so the form can
// give a friendly message before the database would reject the same input.
export const HANDLE_MIN = 3;
export const HANDLE_MAX = 30;
export const BIO_MIN = 20;
export const BIO_MAX = 600;

const RESERVED_HANDLES = new Set([
  "admin", "administrator", "mems", "marketplace", "support", "help",
  "contact", "official", "staff", "moderator", "api", "www", "app",
  "login", "signup", "settings", "root", "system", "null", "undefined",
]);

export function normaliseHandle(input: string): string {
  return input.trim().toLowerCase().replace(/^@/, "");
}

export function validateHandle(input: string): string | null {
  const handle = normaliseHandle(input);
  if (!handle) return "Choose a handle for your public page.";
  if (!/^[a-z0-9][a-z0-9_-]{2,29}$/.test(handle)) {
    return `Use ${HANDLE_MIN}-${HANDLE_MAX} lowercase letters, numbers, "-" or "_", starting with a letter or number.`;
  }
  if (RESERVED_HANDLES.has(handle)) return "That handle isn't available.";
  return null;
}

export function validateDisplayName(input: string): string | null {
  const len = input.trim().length;
  if (len < 2) return "Enter the name you want buyers to see.";
  if (len > 60) return "Keep your name to 60 characters or fewer.";
  return null;
}

export function validateBio(input: string): string | null {
  const len = input.trim().length;
  if (len < BIO_MIN) {
    return `Tell buyers a little about yourself (at least ${BIO_MIN} characters).`;
  }
  if (len > BIO_MAX) return `Keep your bio to ${BIO_MAX} characters or fewer.`;
  return null;
}

// ── Reads ────────────────────────────────────────────────────────────────
export async function getMyCreatorProfile(
  userId: string,
): Promise<CreatorProfile | null> {
  const { data, error } = await supabase
    .from("creator_profiles")
    .select("user_id, handle, display_name, bio, status")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? fromRow(data as Row) : null;
}

export async function getCreatorByHandle(
  handle: string,
): Promise<CreatorProfile | null> {
  const { data, error } = await supabase
    .from("creator_profiles")
    .select("user_id, handle, display_name, bio, status")
    .eq("handle", normaliseHandle(handle))
    .eq("status", "active")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? fromRow(data as Row) : null;
}

export async function listCreators(limit = 60): Promise<CreatorProfile[]> {
  const { data, error } = await supabase
    .from("creator_profiles")
    .select("user_id, handle, display_name, bio, status")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data as Row[]).map(fromRow);
}

// Live seller search by display name or handle (case-insensitive, partial).
export async function searchCreators(term: string, limit = 30): Promise<CreatorProfile[]> {
  // Strip characters that have special meaning in PostgREST filters/LIKE.
  const clean = term.trim().replace(/^@/, "").replace(/[%*_,()"'\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  if (clean.length === 0) return [];
  const { data, error } = await supabase
    .from("creator_profiles")
    .select("user_id, handle, display_name, bio, status")
    .eq("status", "active")
    .or(`display_name.ilike.%${clean}%,handle.ilike.%${clean}%`)
    .order("display_name", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data as Row[]).map(fromRow);
}

// ── Write ────────────────────────────────────────────────────────────────
// Creates or updates the signed-in user's profile. Throws an Error whose
// message is safe to show directly to the user.
export async function saveMyCreatorProfile(
  userId: string,
  input: { handle: string; displayName: string; bio: string },
): Promise<CreatorProfile> {
  const handleError = validateHandle(input.handle);
  if (handleError) throw new Error(handleError);
  const nameError = validateDisplayName(input.displayName);
  if (nameError) throw new Error(nameError);
  const bioError = validateBio(input.bio);
  if (bioError) throw new Error(bioError);

  const { data, error } = await supabase
    .from("creator_profiles")
    .upsert(
      {
        user_id: userId,
        handle: normaliseHandle(input.handle),
        display_name: input.displayName.trim(),
        bio: input.bio.trim(),
      },
      { onConflict: "user_id" },
    )
    .select("user_id, handle, display_name, bio, status")
    .single();

  if (error) {
    // 23505 = unique_violation: someone else already has this handle.
    if ((error as any).code === "23505") {
      throw new Error("That handle is already taken. Try another one.");
    }
    throw new Error("Could not save your profile. Please try again.");
  }
  return fromRow(data as Row);
}
