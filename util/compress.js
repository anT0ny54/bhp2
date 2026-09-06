import sharp from "sharp";

export async function compress(input, useWebp, grayscale, quality, originalSize, maxWidth = 0) {
  try {
    let pipeline = sharp(input, { animated: false, failOn: "none" }).rotate();
    if (maxWidth > 0) pipeline = pipeline.resize({ width: maxWidth, fit: "inside", withoutEnlargement: true, fastShrinkOnLoad: true });
    if (grayscale) pipeline = pipeline.grayscale();

    const output = useWebp
      ? await pipeline.webp({ quality, effort: 4, smartSubsample: true }).toBuffer()
      : await pipeline.jpeg({ quality, progressive: true, mozjpeg: true, chromaSubsampling: "4:2:0" }).toBuffer();

    return {
      err: null,
      output,
      headers: {
        "content-type": useWebp ? "image/webp" : "image/jpeg",
        "content-length": String(output.length),
        "x-original-size": String(originalSize),
        "x-compressed-size": String(output.length),
        "x-bytes-saved": String(Math.max(0, originalSize - output.length)),
      },
    };
  } catch (err) {
    return { err, output: null, headers: {} };
  }
}
