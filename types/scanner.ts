/** Normalized corner point (0-1 range relative to image dimensions) */
export interface ScannerCorner {
  x: number;
  y: number;
}

/** Four corners of the document region */
export interface ScannerCorners {
  tl: ScannerCorner;
  tr: ScannerCorner;
  br: ScannerCorner;
  bl: ScannerCorner;
}

/** Image enhancement mode */
export type EnhanceMode = 'bw' | 'gray' | 'color';

/** Result returned after scanning and processing */
export interface ScanResult {
  /** Base64-encoded PNG data (without data URI prefix) */
  base64: string;
  width: number;
  height: number;
}
