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
