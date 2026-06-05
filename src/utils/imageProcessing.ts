import * as ImageManipulator from "expo-image-manipulator";

type CompressedImage = {
  uri: string;
  width: number;
  height: number;
  blob: Blob;
};

export async function compressImage(
  uri: string,
  originalWidth: number,
  originalHeight: number,
): Promise<CompressedImage> {
  // Max dimension — keeps images sharp but reduces file size
  const MAX_DIMENSION = 1920;

  // Calculate resize dimensions preserving aspect ratio
  let targetWidth = originalWidth;
  let targetHeight = originalHeight;

  if (originalWidth > MAX_DIMENSION || originalHeight > MAX_DIMENSION) {
    if (originalWidth > originalHeight) {
      targetWidth = MAX_DIMENSION;
      targetHeight = Math.round(
        (originalHeight / originalWidth) * MAX_DIMENSION,
      );
    } else {
      targetHeight = MAX_DIMENSION;
      targetWidth = Math.round(
        (originalWidth / originalHeight) * MAX_DIMENSION,
      );
    }
  }

  const actions: ImageManipulator.Action[] = [];

  // Only resize if needed
  if (targetWidth !== originalWidth || targetHeight !== originalHeight) {
    actions.push({ resize: { width: targetWidth, height: targetHeight } });
  }

  const result = await ImageManipulator.manipulateAsync(uri, actions, {
    compress: 0.82, // ← 82% quality — good balance of size vs quality
    format: ImageManipulator.SaveFormat.JPEG,
  });

  const response = await fetch(result.uri);
  const blob = await response.blob();

  return {
    uri: result.uri,
    width: result.width,
    height: result.height,
    blob,
  };
}

// Generate a thumbnail for collection previews — smaller and faster to load
export async function generateThumbnail(uri: string): Promise<Blob> {
  const { Platform } = require("react-native");

  // Web needs larger thumbnails for high-DPI screens
  const thumbWidth = Platform.OS === "web" ? 800 : 400;

  const result = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: thumbWidth } }],
    {
      compress: 0.82, // ← slightly higher quality than before
      format: ImageManipulator.SaveFormat.JPEG,
    },
  );
  const response = await fetch(result.uri);
  return response.blob();
}
