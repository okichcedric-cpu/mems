import { compressImage, generateThumbnail } from "./imageProcessing";
import { supabase } from "./supabase";

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
    // Compress image
    const compressed = await compressImage(uri, originalWidth, originalHeight);

    // Get presigned upload URL from edge function
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

    // Upload full image directly to S3 using presigned URL
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

    // Generate and upload thumbnail — failure here is non-critical
    try {
      const thumbBlob = await generateThumbnail(compressed.uri);
      const { data: thumbUploadData, error: thumbUploadError } =
        await supabase.functions.invoke("generate-upload-url", {
          body: {
            key: thumbKey,
            contentType: "image/jpeg",
            width: 400,
            height: 400,
          },
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
      // Thumbnail failure never blocks the main upload
      console.warn("Thumbnail error:", thumbErr.message);
    }

    return key;
  } catch (error: any) {
    // Pass through known sanitised messages — swallow everything else
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
  const { Platform } = require("react-native");

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
    // Fall back to full image silently
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
}