import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";
import { Platform } from "react-native";
import { deleteCollectionMetadata } from "./collections";
import { compressImage, generateThumbnail } from "./imageProcessing";
import { supabase } from "./supabase";

// ── Native upload helper ───────────────────────────────────────────────────
// CRITICAL: Do NOT use fetch(localUri).blob() on native. React Native's
// fetch implementation cannot reliably read file:// URIs in production/
// standalone builds on Android — it works in Expo Go / dev builds because
// of extra polyfills there, but fails silently or with "Network request
// failed" in a real compiled APK. FileSystem.uploadAsync bypasses fetch
// entirely and streams the local file directly via native code.
async function uploadLocalFileNative(
  presignedUrl: string,
  localUri: string,
): Promise<void> {
  let result;
  try {
    result = await FileSystem.uploadAsync(presignedUrl, localUri, {
      httpMethod: "PUT",
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { "Content-Type": "image/jpeg" },
    });
  } catch (nativeErr: any) {
    console.error("FileSystem.uploadAsync threw:", nativeErr.message);
    throw new Error(`Upload failed: ${nativeErr.message ?? "native upload error"}`);
  }

  if (result.status < 200 || result.status >= 300) {
    console.error("Native upload non-2xx response:", result.status, result.body);
    throw new Error(`Upload failed: ${result.status}`);
  }
}

// ── Native compression helper ───────────────────────────────────────────────
// Uses expo-image-manipulator directly — this is a native module operation
// (no fetch/network involved) so it's safe and reliable on both platforms.
async function compressImageNative(
  uri: string,
  maxDimension: number = 2000,
): Promise<{ uri: string; width: number; height: number }> {
  const actions = maxDimension
    ? [{ resize: { width: maxDimension } }]
    : [];

  const result = await ImageManipulator.manipulateAsync(uri, actions, {
    compress: 0.82,
    format: ImageManipulator.SaveFormat.JPEG,
  });

  return { uri: result.uri, width: result.width, height: result.height };
}

async function generateThumbnailNative(
  uri: string,
): Promise<{ uri: string; width: number; height: number }> {
  const result = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: 400 } }],
    { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG },
  );
  return { uri: result.uri, width: result.width, height: result.height };
}

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

  try {
    if (Platform.OS === "web") {
      // ── WEB — unchanged, already working ────────────────────────
      // Browsers handle Blob/fetch on local files (data URIs, blob URLs)
      // natively, so this path is not affected by the native bug at all.
      const compressed = await compressImage(uri, originalWidth, originalHeight);

      const { data: uploadData, error: uploadError } = await supabase.functions.invoke(
        "generate-upload-url",
        {
          body: {
            key,
            contentType: "image/jpeg",
            fileSize: compressed.blob.size,
            width: compressed.width,
            height: compressed.height,
          },
        }
      );

      if (uploadError || !uploadData?.uploadUrl) {
        console.error("generate-upload-url error:", uploadError?.message);
        throw new Error("Upload failed. Please try again.");
      }

      const arrayBuffer = await compressed.blob.arrayBuffer();
      const uploadResponse = await fetch(uploadData.uploadUrl, {
        method: "PUT",
        body: arrayBuffer,
        headers: { "Content-Type": "image/jpeg" },
      });

      if (!uploadResponse.ok) {
        console.error("S3 PUT failed:", uploadResponse.status, uploadResponse.statusText);
        throw new Error("Upload failed. Please check your connection and try again.");
      }

      // Thumbnail — failure here is non-critical
      try {
        const thumbBlob = await generateThumbnail(compressed.uri);
        const { data: thumbUploadData, error: thumbUploadError } =
          await supabase.functions.invoke("generate-upload-url", {
            body: { key: thumbKey, contentType: "image/jpeg", width: 400, height: 400 },
          });

        if (thumbUploadError || !thumbUploadData?.uploadUrl) {
          console.warn("Thumbnail URL generation failed:", thumbUploadError?.message);
        } else {
          const thumbBuffer = await thumbBlob.arrayBuffer();
          const thumbResponse = await fetch(thumbUploadData.uploadUrl, {
            method: "PUT",
            body: thumbBuffer,
            headers: { "Content-Type": "image/jpeg" },
          });
          if (!thumbResponse.ok) {
            console.warn("Thumbnail upload failed:", thumbResponse.status);
          }
        }
      } catch (thumbErr: any) {
        console.warn("Thumbnail error:", thumbErr.message);
      }

    } else {
      // ── NATIVE (iOS / Android) ──────────────────────────────────
      // Compress via expo-image-manipulator (native module, no fetch),
      // then upload the resulting local file directly via
      // FileSystem.uploadAsync (legacy API) — never touches fetch/Blob
      // for the actual file data, sidestepping the file:// fetch bug
      // that breaks in production/standalone builds on Android.
      const compressed = await compressImageNative(uri);

      let fileSize: number | undefined;
      try {
        const info = await FileSystem.getInfoAsync(compressed.uri);
        fileSize = info.exists ? (info as any).size : undefined;
      } catch (infoErr: any) {
        console.warn("getInfoAsync error (non-fatal):", infoErr.message);
      }

      const { data: uploadData, error: uploadError } = await supabase.functions.invoke(
        "generate-upload-url",
        {
          body: {
            key,
            contentType: "image/jpeg",
            fileSize,
            width: compressed.width,
            height: compressed.height,
          },
        }
      );

      if (uploadError || !uploadData?.uploadUrl) {
        console.error("generate-upload-url error:", uploadError?.message);
        throw new Error("Upload failed. Please try again.");
      }

      await uploadLocalFileNative(uploadData.uploadUrl, compressed.uri);

      // Thumbnail — failure here is non-critical, never blocks main upload
      try {
        const thumb = await generateThumbnailNative(compressed.uri);
        const { data: thumbUploadData, error: thumbUploadError } =
          await supabase.functions.invoke("generate-upload-url", {
            body: {
              key: thumbKey,
              contentType: "image/jpeg",
              width: thumb.width,
              height: thumb.height,
            },
          });

        if (thumbUploadError || !thumbUploadData?.uploadUrl) {
          console.warn("Thumbnail URL generation failed:", thumbUploadError?.message);
        } else {
          await uploadLocalFileNative(thumbUploadData.uploadUrl, thumb.uri);
        }
      } catch (thumbErr: any) {
        console.warn("Thumbnail error:", thumbErr.message);
      }
    }

    return key;
  } catch (error: any) {
    const knownMessages = [
      "Upload failed. Please try again.",
      "Upload failed. Please check your connection and try again.",
    ];
    if (knownMessages.includes(error.message)) throw error;
    console.error("uploadToS3 unexpected error:", error.message);
    throw new Error("Upload failed. Please try again.");
  }
}

// ── Signed URLs ───────────────────────────────────────────────────────────────

export async function getSignedPhotoUrl(key: string): Promise<string> {
  try {
    const { data, error } = await supabase.functions.invoke("generate-read-url", {
      body: { key },
    });
    if (error) throw new Error(error.message);
    return data.url;
  } catch (error: any) {
    console.error("getSignedPhotoUrl error:", error.message);
    throw new Error("Could not load photo. Please try again.");
  }
}

export async function getSignedThumbnailUrl(key: string): Promise<string> {
  if (Platform.OS === "web") {
    return getSignedPhotoUrl(key);
  }

  const parts = key.split("/");
  const fileName = parts.pop()!;
  const thumbKey = [...parts, "thumbs", fileName].join("/");

  try {
    const { data, error } = await supabase.functions.invoke("generate-read-url", {
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
  try {
    const { data, error } = await supabase.functions.invoke("generate-read-url", {
      body: { key },
    });
    if (error) throw new Error(error.message);
    return data.metadata ?? { width: 1, height: 1 };
  } catch (error: any) {
    console.error("getPhotoMetadata error:", error.message);
    return { width: 1, height: 1 };
  }
}

// ── List ──────────────────────────────────────────────────────────────────────

export async function listPhotos(userId: string, collectionName: string) {
  try {
    const { data, error } = await supabase.functions.invoke("list-photos", {
      body: { userId, collectionName },
    });
    if (error) throw new Error(error.message);
    return data?.photos || [];
  } catch (error: any) {
    console.error("listPhotos error:", error.message);
    throw new Error("Could not load photos. Please try again.");
  }
}

export async function listCollections(userId: string): Promise<string[]> {
  try {
    const { data, error } = await supabase.functions.invoke("list-collections", {
      body: { userId },
    });
    if (error) throw new Error(error.message);
    return data?.collections || [];
  } catch (error: any) {
    console.error("listCollections error:", error.message);
    throw new Error("Could not load collections. Please try again.");
  }
}

// ── Collection preview ────────────────────────────────────────────────────────

export async function getCollectionPreviewUrls(
  userId: string,
  collectionName: string,
): Promise<string[]> {
  try {
    const photos = await listPhotos(userId, collectionName);
    const first3 = photos
      .filter((obj: any) => obj.Key && !obj.Key.includes("/thumbs/"))
      .slice(0, 3);

    const urls = await Promise.allSettled(
      first3.map((obj: any) => getSignedThumbnailUrl(obj.Key!)),
    );

    return urls
      .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
      .map((r) => r.value);
  } catch (error: any) {
    console.error("getCollectionPreviewUrls error:", error.message);
    return [];
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function deleteFromS3(key: string): Promise<void> {
  try {
    const { error } = await supabase.functions.invoke("delete-object", {
      body: { key },
    });
    if (error) throw new Error(error.message);
  } catch (error: any) {
    console.error("deleteFromS3 error:", error.message);
    throw new Error("Could not delete photo. Please try again.");
  }
}

export async function deleteCollection(
  userId: string,
  collectionName: string,
): Promise<void> {
  try {
    const photos = await listPhotos(userId, collectionName);
    const realPhotos = photos.filter(
      (obj: any) => obj.Key && !obj.Key.includes("/thumbs/")
    );
    await Promise.all(realPhotos.map((obj: any) => deleteFromS3(obj.Key!)));
  } catch (error: any) {
    console.error("deleteCollection error:", error.message);
    throw new Error("Could not delete collection. Please try again.");
  }

  // Best-effort — the collection itself is already gone from S3 at this
  // point, so a failure here just leaves a harmless orphaned metadata row
  // rather than blocking the deletion the user actually asked for.
  try {
    await deleteCollectionMetadata(userId, collectionName);
  } catch (error: any) {
    console.warn("deleteCollection metadata cleanup error:", error.message);
  }
}

// ── Rename ────────────────────────────────────────────────────────────────────
// A collection's "name" is also its literal S3 folder — there's no separate
// database row to just update, so this hands off to an edge function that
// copies every object (photos + thumbnails) to the new prefix, deletes the
// old ones, and repoints any active shares at the new name. Returns the
// final name the collection now has.
export async function renameCollection(
  oldName: string,
  newName: string,
): Promise<string> {
  const { data, error } = await supabase.functions.invoke("rename-collection", {
    body: { oldName, newName },
  });

  if (error) {
    // supabase.functions.invoke()'s error.message is just a generic
    // wrapper — the actual reason lives in the response body.
    let detail = error.message;
    try {
      const body = await (error as any)?.context?.json?.();
      if (body?.error) detail = body.error;
    } catch {
      try {
        detail = await (error as any)?.context?.text?.();
      } catch {
        // context wasn't readable either — fall back to the generic message
      }
    }
    console.error("renameCollection error:", detail);
    throw new Error(detail);
  }

  return data?.newName ?? newName;
}