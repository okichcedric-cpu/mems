import { supabase } from './supabase';

// Share a collection with someone by email
export async function shareCollection(
  ownerId: string,
  ownerEmail: string,
  collectionName: string,
  recipientEmail: string,
): Promise<void> {
  const email = recipientEmail.trim().toLowerCase();

  if (email === ownerEmail.toLowerCase()) {
    throw new Error("You can't share a collection with yourself.");
  }

  // Check if already shared
  const { data: existing } = await supabase
    .from('shared_collections')
    .select('id')
    .eq('owner_id', ownerId)
    .eq('collection_name', collectionName)
    .eq('recipient_email', email)
    .maybeSingle();

  if (existing) {
    throw new Error('This collection is already shared with that email.');
  }

  // Insert share record
  const { error } = await supabase.from('shared_collections').insert({
    owner_id: ownerId,
    collection_name: collectionName,
    recipient_email: email,
    owner_email: ownerEmail,
  });

  if (error) throw new Error(error.message);

  // Send email via edge function. The function now requires auth (it
  // verifies the caller, derives ownerEmail from the JWT itself, and
  // checks the shared_collections row we just inserted) — pass the
  // access token explicitly rather than relying on the client's default
  // session attachment, same as getSharedCollections() below.
  const { data: { session } } = await supabase.auth.getSession();

  const { error: fnError } = await supabase.functions.invoke('send-share-email', {
    headers: session ? { Authorization: `Bearer ${session.access_token}` } : undefined,
    body: {
      recipientEmail: email,
      collectionName,
    },
  });

  if (fnError) {
    console.warn('Share saved but email failed:', fnError.message);
    // Don't throw — share was saved successfully, email is non-critical
  }
}

// Get all collections shared with the current user
export async function getSharedCollections(userEmail: string): Promise<{
  ownerId: string;
  ownerEmail: string;
  collectionName: string;
}[]> {
  // Force refresh the session to get the current user's token
  const { data: { session }, error: sessionError } = await supabase.auth.refreshSession();

  if (sessionError || !session) {
    // Fall back to getSession if refresh fails
    const { data: { session: fallbackSession } } = await supabase.auth.getSession();
    if (!fallbackSession) return [];

  

    const { data, error } = await supabase.functions.invoke('get-shared-collections', {
      headers: {
        Authorization: `Bearer ${fallbackSession.access_token}`,
      },
    });
    if (error) throw new Error(error.message);
    return data?.collections ?? [];
  }

 

  const { data, error } = await supabase.functions.invoke('get-shared-collections', {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (error) throw new Error(error.message);
  return data?.collections ?? [];
}

// Get list of emails a collection is shared with
export async function getCollectionShares(
  ownerId: string,
  collectionName: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from('shared_collections')
    .select('recipient_email')
    .eq('owner_id', ownerId)
    .eq('collection_name', collectionName);

  if (error) throw new Error(error.message);
  return (data || []).map((row) => row.recipient_email);
}

// Remove a share
export async function unshareCollection(
  ownerId: string,
  collectionName: string,
  recipientEmail: string,
): Promise<void> {
  const { error } = await supabase
    .from('shared_collections')
    .delete()
    .eq('owner_id', ownerId)
    .eq('collection_name', collectionName)
    .eq('recipient_email', recipientEmail.toLowerCase());

  if (error) throw new Error(error.message);
}

// Wipe every share of a collection at once — used when the collection
// itself is deleted. Without this, `shared_collections` rows are keyed
// only on (owner_id, collection_name), which is just a name, not a
// stable id tied to any particular S3 folder "instance". If those rows
// are left behind after a delete, creating a brand new collection that
// happens to reuse the same name silently inherits the old shares —
// the previous recipients would see themselves as sharees of a
// collection they were never actually invited to. Best-effort: called
// after S3 deletion already succeeded, so a failure here should never
// block the delete the user asked for, it just risks the name-reuse
// scenario above rather than losing user data.
export async function deleteAllCollectionShares(
  ownerId: string,
  collectionName: string,
): Promise<void> {
  const { error } = await supabase
    .from('shared_collections')
    .delete()
    .eq('owner_id', ownerId)
    .eq('collection_name', collectionName);

  if (error) throw new Error(error.message);
}