import { supabase } from "./supabase";

// ── Collection metadata ──────────────────────────────────────────────────────
// A collection is fundamentally an S3 folder prefix (see s3.ts) — it has no
// database row of its own. This file is the one exception: it manages an
// OPTIONAL row in the `collections` table that exists purely to carry
// metadata about a collection (currently just the "memory date" — when the
// photos actually happened, as opposed to when they were uploaded).
//
// Absence of a row is a perfectly normal state, meaning "no memory date set
// yet" — every function here is written to treat that as the default rather
// than an error. These call the `collections` table directly (same pattern
// already used for `shared_collections` in sharing.ts) rather than through
// an edge function, since it's a plain RLS-guarded read/write with no S3 or
// other AWS work involved.

export async function getCollectionMemoryDate(
  ownerId: string,
  name: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("collections")
      .select("memory_date")
      .eq("owner_id", ownerId)
      .eq("name", name)
      .maybeSingle();

    if (error) {
      console.warn("getCollectionMemoryDate error:", error.message);
      return null;
    }
    return data?.memory_date ?? null;
  } catch (error: any) {
    console.warn("getCollectionMemoryDate error:", error.message);
    return null;
  }
}

// Pass `memoryDate: null` to clear it. Upserts on (owner_id, name) — the
// row may not exist yet (e.g. this is the first time a date has ever been
// set on a collection created before this feature existed).
export async function setCollectionMemoryDate(
  ownerId: string,
  name: string,
  memoryDate: string | null,
): Promise<void> {
  const { error } = await supabase.from("collections").upsert(
    {
      owner_id: ownerId,
      name,
      memory_date: memoryDate,
    },
    { onConflict: "owner_id,name" },
  );

  if (error) {
    console.error("setCollectionMemoryDate error:", error.message);
    throw new Error("Could not save the date. Please try again.");
  }
}

// Note: renaming a collection's metadata row happens server-side, inside
// the rename-collection edge function (atomically alongside the S3
// copy/delete and the shared_collections update) — there's no client-side
// rename helper here to avoid a second, separate write that could drift
// out of sync if it failed independently.

// Best-effort — called after a collection is deleted so its metadata row
// doesn't go stale/orphaned. Never throws: losing track of a memory date
// is a much smaller problem than blocking a delete over a metadata row
// that may not even exist.
export async function deleteCollectionMetadata(
  ownerId: string,
  name: string,
): Promise<void> {
  const { error } = await supabase
    .from("collections")
    .delete()
    .eq("owner_id", ownerId)
    .eq("name", name);

  if (error) {
    console.warn("deleteCollectionMetadata error:", error.message);
  }
}
