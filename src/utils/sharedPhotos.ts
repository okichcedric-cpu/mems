import { supabase } from './supabase';

// ── Individual photo shares ───────────────────────────────────────────
// Sibling to sharing.ts's collection-level shareCollection/getSharedCollections/
// etc. — same shape, same error handling, deliberately kept as its own
// module rather than folded into sharing.ts so "share a photo" and "share
// a collection" stay two independently readable flows even though they
// look similar. See supabase/migrations/20260914090000_create_shared_photos.sql
// for why this is its own table instead of a variant row in shared_collections.

// Share a single photo with someone by email. `collectionName` is stored
// alongside the photo purely for display — it's what lets the recipient's
// home screen card and single-photo view show "from Ced's Family Trip
// 2024" without a second lookup — it is NOT itself a grant to browse that
// collection; every access check against this table filters on the exact
// photo_key, never just owner_id + collection_name.
export async function sharePhoto(
  ownerId: string,
  ownerEmail: string,
  collectionName: string,
  photoKey: string,
  recipientEmail: string,
): Promise<void> {
  const email = recipientEmail.trim().toLowerCase();

  if (email === ownerEmail.toLowerCase()) {
    throw new Error("You can't share a photo with yourself.");
  }

  const { data: existing, error: existingError } = await supabase
    .from('shared_photos')
    .select('id')
    .eq('owner_id', ownerId)
    .eq('photo_key', photoKey)
    .eq('recipient_email', email)
    .maybeSingle();

  if (existingError) {
    throw new Error(existingError.message);
  }

  if (existing) {
    throw new Error('This photo is already shared with that email.');
  }

  const { error } = await supabase.from('shared_photos').insert({
    owner_id: ownerId,
    owner_email: ownerEmail,
    collection_name: collectionName,
    photo_key: photoKey,
    recipient_email: email,
  });

  if (error) throw new Error(error.message);

  // Send email via edge function — same auth/verification contract as
  // send-share-email for collections (see that function's handling of an
  // optional `photoKey` in its body).
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const { error: fnError } = await supabase.functions.invoke(
    'send-share-email',
    {
      headers: session
        ? { Authorization: `Bearer ${session.access_token}` }
        : undefined,
      body: {
        recipientEmail: email,
        collectionName,
        photoKey,
      },
    },
  );

  if (fnError) {
    console.warn('Photo share saved but email failed:', fnError.message);
    // Don't throw — the share itself was saved; email is non-critical.
  }
}

// Share MULTIPLE photos with one recipient in a single action — backs
// the grid's long-press multi-select flow (see collection/[id].tsx's
// selectionMode). Same per-key rules as sharePhoto() above (can't share
// with yourself; a key already shared with this email is silently
// skipped rather than failing the whole batch over one duplicate), but
// ends in exactly ONE email via send-share-email's batch `photoKeys`
// path — calling sharePhoto() once per key here would fire one email
// per photo, which reads as spam for anything more than a couple of
// photos.
export async function sharePhotos(
  ownerId: string,
  ownerEmail: string,
  collectionName: string,
  photoKeys: string[],
  recipientEmail: string,
): Promise<{ sharedCount: number }> {
  const email = recipientEmail.trim().toLowerCase();

  if (email === ownerEmail.toLowerCase()) {
    throw new Error("You can't share a photo with yourself.");
  }
  if (photoKeys.length === 0) {
    throw new Error('No photos selected.');
  }

  const { data: existingRows, error: existingError } = await supabase
    .from('shared_photos')
    .select('photo_key')
    .eq('owner_id', ownerId)
    .eq('recipient_email', email)
    .in('photo_key', photoKeys);

  if (existingError) {
    throw new Error(existingError.message);
  }

  const alreadyShared = new Set((existingRows ?? []).map((row) => row.photo_key));
  const newKeys = photoKeys.filter((key) => !alreadyShared.has(key));

  if (newKeys.length === 0) {
    throw new Error('These photos are already shared with that email.');
  }

  const { error } = await supabase.from('shared_photos').insert(
    newKeys.map((photoKey) => ({
      owner_id: ownerId,
      owner_email: ownerEmail,
      collection_name: collectionName,
      photo_key: photoKey,
      recipient_email: email,
    })),
  );

  if (error) throw new Error(error.message);

  // One email covering the whole selection — see send-share-email's own
  // comment on its photoKeys (plural) branch. Sends the full requested
  // list, not just newKeys, so the email reflects what the owner meant
  // to share even if a couple of the selected photos were already
  // shared with this person before.
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const { error: fnError } = await supabase.functions.invoke(
    'send-share-email',
    {
      headers: session
        ? { Authorization: `Bearer ${session.access_token}` }
        : undefined,
      body: {
        recipientEmail: email,
        collectionName,
        photoKeys,
      },
    },
  );

  if (fnError) {
    console.warn('Photo batch share saved but email failed:', fnError.message);
    // Don't throw — the shares themselves were saved; email is non-critical.
  }

  return { sharedCount: newKeys.length };
}

// Get every photo shared with the current user — mirrors
// getSharedCollections()'s session-refresh-then-fallback dance.
export type SharedPhoto = {
  ownerId: string;
  ownerEmail: string;
  collectionName: string;
  photoKey: string;
  url: string | null;
  thumbUrl: string | null;
  metadata: { width: number; height: number };
  // Read live from photo_captions at fetch time (see get-shared-photos),
  // not copied at share time — so if the owner edits or adds a caption
  // after sharing, the recipient sees the current text, exactly like a
  // full-collection share already does. Undefined means no caption set.
  caption?: string;
};

export async function getSharedPhotos(): Promise<SharedPhoto[]> {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.refreshSession();

  const activeSession =
    !sessionError && session
      ? session
      : (await supabase.auth.getSession()).data.session;

  if (!activeSession) return [];

  const { data, error } = await supabase.functions.invoke(
    'get-shared-photos',
    { headers: { Authorization: `Bearer ${activeSession.access_token}` } },
  );

  if (error) throw new Error(error.message);
  return data?.photos ?? [];
}

// Get list of emails a specific photo is shared with — scoped to owner_id
// + photo_key (NOT collection_name), so this only ever reflects shares of
// that exact photo.
export async function getPhotoShares(
  ownerId: string,
  photoKey: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from('shared_photos')
    .select('recipient_email')
    .eq('owner_id', ownerId)
    .eq('photo_key', photoKey);

  if (error) throw new Error(error.message);
  return (data || []).map((row) => row.recipient_email);
}

// Remove a single share of one photo.
export async function unsharePhoto(
  ownerId: string,
  photoKey: string,
  recipientEmail: string,
): Promise<void> {
  const { error } = await supabase
    .from('shared_photos')
    .delete()
    .eq('owner_id', ownerId)
    .eq('photo_key', photoKey)
    .eq('recipient_email', recipientEmail.toLowerCase());

  if (error) throw new Error(error.message);
}

// Best-effort — called right after a photo is deleted, mirrors
// deletePhotoCaption's reasoning (the photo itself is already gone from
// S3 at that point; this is cleanup, not something that should block the
// delete the user asked for). Never throws.
export async function deletePhotoSharesForPhoto(
  ownerId: string,
  photoKey: string,
): Promise<void> {
  const { error } = await supabase
    .from('shared_photos')
    .delete()
    .eq('owner_id', ownerId)
    .eq('photo_key', photoKey);

  if (error) {
    console.warn('deletePhotoSharesForPhoto error:', error.message);
  }
}

// Best-effort — called from deleteCollection(), mirrors
// deletePhotoCaptionsForCollection's single sweep-by-prefix rather than
// one delete per photo. Never throws.
export async function deletePhotoSharesForCollection(
  ownerId: string,
  collectionName: string,
): Promise<void> {
  const prefix = `${ownerId}/${collectionName}/`;
  const { error } = await supabase
    .from('shared_photos')
    .delete()
    .eq('owner_id', ownerId)
    .like('photo_key', `${prefix}%`);

  if (error) {
    console.warn('deletePhotoSharesForCollection error:', error.message);
  }
}
