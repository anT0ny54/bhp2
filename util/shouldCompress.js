const MIN_COMPRESS_LENGTH = 1024;

export default function shouldCompress(contentType, size) {
  return typeof contentType === "string" &&
    contentType.toLowerCase().startsWith("image/") &&
    Number.isFinite(size) && size >= MIN_COMPRESS_LENGTH;
}
