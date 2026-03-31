import { requireNativeModule } from 'expo-modules-core';

interface Corners {
  tl: { x: number; y: number };
  tr: { x: number; y: number };
  br: { x: number; y: number };
  bl: { x: number; y: number };
}

const DocumentDetection = requireNativeModule('DocumentDetection');

/**
 * Detect document boundaries in a base64 image.
 * iOS uses Apple Vision framework; Android uses native gradient RANSAC algorithm.
 * Returns normalized corner coordinates (0-1) or null if no document found.
 */
export async function detectDocument(base64: string): Promise<Corners | null> {
  return DocumentDetection.detectDocument(base64);
}

/**
 * Native perspective correction + enhancement.
 * Uses Core Image on iOS — handles full-res images without WebView limits.
 */
export async function processImageNative(
  base64: string,
  corners: Corners,
  mode: 'color' | 'gray' | 'bw'
): Promise<{ base64: string; width: number; height: number }> {
  return DocumentDetection.processImageNative(base64, corners, mode);
}

/**
 * Native image editing — rotation, filters, adjustments.
 * Uses Core Image on iOS — full resolution, GPU accelerated.
 */
export async function applyEditsNative(
  base64: string,
  rotation: number,
  brightness: number,
  contrast: number,
  saturation: number,
  warmth: number,
  sepia: number,
  grayscale: number
): Promise<{ base64: string; width: number; height: number }> {
  return DocumentDetection.applyEditsNative(base64, rotation, brightness, contrast, saturation, warmth, sepia, grayscale);
}
