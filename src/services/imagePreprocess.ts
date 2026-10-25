import sharp, { type Metadata } from 'sharp';
import { badRequest } from '../http/errors.ts';

export const MAX_EDGE_PX = 1280;
/** Rejects decompression bombs before decoding (≈ 6000 × 6000). */
const MAX_INPUT_PIXELS = 36_000_000;
const MIN_EDGE_PX = 320;

/** Editing / generation software that has no business in a fresh camera capture's EXIF. */
const EDITOR_SIGNATURES = ['photoshop', 'gimp', 'lightroom', 'snapseed', 'picsart', 'canva', 'affinity', 'pixelmator', 'facetune', 'stable diffusion', 'midjourney', 'dall-e'];

export interface NormalizedImage {
  /** Re-encoded JPEG, EXIF-rotated, ≤ 1280 px on the long edge, all metadata stripped. */
  jpeg: Buffer;
  /** Raw RGB pixels of `jpeg`, for the face engine. */
  rgb: Buffer;
  width: number;
  height: number;
  /** Things worth a reviewer's look; not failures on their own. */
  warnings: string[];
}

/**
 * Decodes an upload once, safely: rejects non-images and oversized inputs,
 * applies EXIF orientation, downsizes, and re-encodes so nothing from the
 * original file (metadata, trailing payloads) survives.
 */
export async function normalizeImage(input: Buffer, label: string): Promise<NormalizedImage> {
  let metadata: Metadata;
  try {
    metadata = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw badRequest('invalid_image', `${label} isn’t a readable image.`);
  }
  if (!metadata.format || !['jpeg', 'png', 'webp', 'heif'].includes(metadata.format)) {
    throw badRequest('invalid_image', `${label} must be a JPEG, PNG or WebP photo.`);
  }

  const warnings: string[] = [];
  const exifText = metadata.exif ? metadata.exif.toString('latin1').toLowerCase() : '';
  const editor = EDITOR_SIGNATURES.find((signature) => exifText.includes(signature));
  if (editor) warnings.push(`exif_editor:${editor}`);
  if (metadata.format === 'png') warnings.push('png_not_camera_format');
  if ((metadata.width ?? 0) < MIN_EDGE_PX || (metadata.height ?? 0) < MIN_EDGE_PX) {
    throw badRequest('image_too_small', `${label} is too small; take the photo closer and in focus.`);
  }

  try {
    const pipeline = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: 'inside', withoutEnlargement: true })
      .removeAlpha();
    const jpeg = await pipeline.clone().jpeg({ quality: 90, mozjpeg: true }).toBuffer();
    const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
    return { jpeg, rgb: data, width: info.width, height: info.height, warnings };
  } catch {
    throw badRequest('invalid_image', `${label} couldn’t be processed; retake the photo.`);
  }
}

/** Overwrites image buffers once they're no longer needed (best effort: JS can't scrub copies the engine made). */
export function wipe(...buffers: (Buffer | undefined | null)[]) {
  for (const buffer of buffers) buffer?.fill(0);
}
