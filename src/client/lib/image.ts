export async function fileToLogoDataUrl(file: File, size = 512): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose a PNG, JPG, WebP or SVG image.");
  if (file.size > 6 * 1024 * 1024) throw new Error("Image must be smaller than 6 MB.");
  if (file.type === "image/svg+xml") {
    const text = await file.text();
    if (/<script|onload=|onerror=|foreignObject/i.test(text)) {
      throw new Error("This SVG contains unsupported active content.");
    }
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(text)))}`;
  }
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable in this browser.");
  const scale = Math.max(size / bitmap.width, size / bitmap.height);
  const drawWidth = bitmap.width * scale;
  const drawHeight = bitmap.height * scale;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, (size - drawWidth) / 2, (size - drawHeight) / 2, drawWidth, drawHeight);
  bitmap.close();
  return canvas.toDataURL("image/webp", 0.9);
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file."));
    reader.readAsText(file);
  });
}
