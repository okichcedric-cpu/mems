import { compressImage, generateThumbnail } from "./imageProcessing";
import { supabase } from "./supabase";

const BUCKET = process.env.EXPO_PUBLIC_S3_BUCKET!;

// ── Upload ────────────────────────────────────────────────────────────────────

export async function uploadToS3(
  userId: string,
  collectionName: string,
  fileName: string,
  uri: string,
  originalWidth: number,
  originalHeight: number,
): Promise<string> {
  const key = `${userId}/${collectionName}/${fileName}`;
  const thumbKey = `${userId}/${collectionName}/thumbs/${fileName}`;

  // Compress image
  const compressed = await compressImage(uri, originalWidth, originalHeight);

  // Get presigned upload URL from edge function
  const { data: uploadData, error: uploadError } = await supabase.functions.invoke(
    'generate-upload-url',
    {
      body: {
        key,
        contentType: 'image/jpeg',
        width: compressed.width,
        height: compressed.height,
      },
    }
  );
  if (uploadError) throw new Error(uploadError.message);

  // Upload full image directly to S3 using presigned URL
  const arrayBuffer = await compressed.blob.arrayBuffer();
  const uploadResponse = await fetch(uploadData.url, {
    method: 'PUT',
    body: arrayBuffer,
    headers: { 'Content-Type': 'image/jpeg' },
  });
  if (!uploadResponse.ok) throw new Error(`Upload failed: ${uploadResponse.status}`);

  // Generate and upload thumbnail
  const thumbBlob = await generateThumbnail(compressed.uri);
  const { data: thumbUploadData, error: thumbUploadError } = await supabase.functions.invoke(
    'generate-upload-url',
    {
      body: {
        key: thumbKey,
        contentType: 'image/jpeg',
        width: 400,
        height: 400,
      },
    }
  );
  if (thumbUploadError) throw new Error(thumbUploadError.message);

  const thumbBuffer = await thumbBlob.arrayBuffer();
  await fetch(thumbUploadData.url, {
    method: 'PUT',
    body: thumbBuffer,
    headers: { 'Content-Type': 'image/jpeg' },
  });

  return key;
}

// ── Signed URLs ───────────────────────────────────────────────────────────────

export async function getSignedPhotoUrl(key: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke('generate-read-url', {
    body: { key },
  });
  if (error) throw new Error(error.message);
  return data.url;
}

export async function getSignedThumbnailUrl(key: string): Promise<string> {
  const { Platform } = require('react-native');

  // On web serve full image to avoid pixelation on high-DPI screens
  if (Platform.OS === 'web') {
    return getSignedPhotoUrl(key);
  }

  // On mobile try thumbnail first, fall back to full image
  const parts = key.split('/');
  const fileName = parts.pop()!;
  const thumbKey = [...parts, 'thumbs', fileName].join('/');

  try {
    const { data, error } = await supabase.functions.invoke('generate-read-url', {
      body: { key: thumbKey },
    });
    if (error) throw new Error(error.message);
    return data.url;
  } catch {
    return getSignedPhotoUrl(key);
  }
}

// ── Metadata ──────────────────────────────────────────────────────────────────

export async function getPhotoMetadata(
  key: string,
): Promise<{ width: number; height: number }> {
  const { data, error } = await supabase.functions.invoke('generate-read-url', {
    body: { key },
  });
  if (error) throw new Error(error.message);
  return data.metadata ?? { width: 1, height: 1 };
}

// ── List ──────────────────────────────────────────────────────────────────────

export async function listPhotos(userId: string, collectionName: string) {
  const { data, error } = await supabase.functions.invoke('list-photos', {
    body: { userId, collectionName },
  });
  if (error) throw new Error(error.message);
  return data?.photos || [];
}

export async function listCollections(userId: string): Promise<string[]> {
  const { data, error } = await supabase.functions.invoke('list-collections', {
    body: { userId },
  });
  if (error) throw new Error(error.message);
  return data?.collections || [];
}

// ── Collection preview ────────────────────────────────────────────────────────

export async function getCollectionPreviewUrls(
  userId: string,
  collectionName: string,
): Promise<string[]> {
  const photos = await listPhotos(userId, collectionName);

  const first3 = photos
    .filter((obj: any) => obj.Key && !obj.Key.includes('/thumbs/'))
    .slice(0, 3);

  const urls = await Promise.allSettled(
    first3.map((obj: any) => getSignedThumbnailUrl(obj.Key!)),
  );

  return urls
    .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
    .map((r) => r.value);
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function deleteFromS3(key: string): Promise<void> {
  const { error } = await supabase.functions.invoke('delete-object', {
    body: { key },
  });
  if (error) throw new Error(error.message);
}

export async function deleteCollection(
  userId: string,
  collectionName: string,
): Promise<void> {
  // Delete all photos from S3
  const photos = await listPhotos(userId, collectionName);
  const realPhotos = photos.filter(
    (obj: any) => obj.Key && !obj.Key.includes('/thumbs/')
  );
  await Promise.all(realPhotos.map((obj: any) => deleteFromS3(obj.Key!)));

  // Delete share records from Supabase
  await supabase
    .from('shared_collections')
    .delete()
    .eq('owner_id', userId)
    .eq('collection_name', collectionName);
}