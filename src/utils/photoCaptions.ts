import { supabase } from "./supabase";

// ── Per-photo captions ────────────────────────────────────────────────────────
// A photo has no database row of its own (see collections.ts's header comment
// on the same situation for collection metadata) — this file manages an
// OPTIONAL row in the `photo_captions` table, keyed by the photo's full S3
// object key. Absence of a row means "no caption set", the normal default
// state, not an error. Same direct-client, RLS-guarded pattern as
// collections.ts's memory-date helpers (owner-only; shared-collection
// viewers read captions through the list-photos edge function instead,
// which already re-derives access on every call — see that function).

export async function setPhotoCaption(
  ownerId: string,
  photoKey: string,
  caption: string,
): Promise<void> {
  const trimmed = caption.trim();

  // An empty caption isn't a value worth storing — delete the row instead
  // of upserting an empty string, so "never captioned" and "captioned,
  // then cleared" collapse back to the same absence-of-a-row state.
  if (!trimmed) {
    await deletePhotoCaption(ownerId, photoKey);
    return;
  }

  const { error } = await supabase.from("photo_captions").upsert(
    {
      owner_id: ownerId,
      photo_key: photoKey,
      caption: trimmed,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "owner_id,photo_key" },
  );

  if (error) {
    console.error("setPhotoCaption error:", error.message);
    throw new Error("Could not save the caption. Please try again.");
  }
}

// Best-effort — mirrors deleteCollectionMetadata's reasoning: called after
// a photo is deleted (or a caption is cleared) so its row doesn't go stale.
// Never throws.
export async function deletePhotoCaption(
  ownerId: string,
  photoKey: string,
): Promise<void> {
  const { error } = await supabase
    .from("photo_captions")
    .delete()
    .eq("owner_id", ownerId)
    .eq("photo_key", photoKey);

  if (error) {
    console.warn("deletePhotoCaption error:", error.message);
  }
}

// Called from deleteCollection() — every photo under a collection's S3
// prefix is gone at that point, so this is a single best-effort sweep
// rather than one delete per photo. Also best-effort, never throws: the
// collection itself is already deleted either way.
export async function deletePhotoCaptionsForCollection(
  ownerId: string,
  collectionName: string,
): Promise<void> {
  const prefix = `${ownerId}/${collectionName}/`;
  const { error } = await supabase
    .from("photo_captions")
    .delete()
    .eq("owner_id", ownerId)
    .like("photo_key", `${prefix}%`);

  if (error) {
    console.warn("deletePhotoCaptionsForCollection error:", error.message);
  }
}
