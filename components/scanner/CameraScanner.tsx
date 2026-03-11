import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  LayoutChangeEvent,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { File } from 'expo-file-system';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useTranslation } from 'react-i18next';
import type { ImageProcessorHandle } from './ImageProcessor';
import Svg, { Polygon } from 'react-native-svg';
import { detectDocument } from '@/modules/document-detection/src';
import type { ScannerCorners, ScannerCorner } from '@/types';

interface CameraScannerProps {
  processorRef: React.RefObject<ImageProcessorHandle | null>;
  onCapture: (
    uri: string,
    width: number,
    height: number,
    corners: ScannerCorners | null,
    base64: string,
  ) => void;
  onPickLibrary: () => void;
}

const OVERLAY_FILL = 'rgba(0,120,255,0.25)';
const OVERLAY_STROKE = 'rgba(0,120,255,0.8)';
const STROKE_WIDTH = 3;

export default function CameraScanner({
  processorRef,
  onCapture,
  onPickLibrary,
}: CameraScannerProps) {
  const { t } = useTranslation();
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraReady, setCameraReady] = useState(false);
  const [flash, setFlash] = useState<'off' | 'on' | 'auto'>('off');
  const [detectedCorners, setDetectedCorners] = useState<ScannerCorners | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [layout, setLayout] = useState({ width: 0, height: 0 });
  const [pictureSize, setPictureSize] = useState<string | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detectingRef = useRef(false);
  const lastCornersRef = useRef<ScannerCorners | null>(null);
  const lastDetectTimeRef = useRef(0);

  // Request permission on mount
  useEffect(() => {
    if (!permission?.granted) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  // Lerp helper for temporal smoothing
  const lerpCorners = useCallback(
    (a: ScannerCorners, b: ScannerCorners, t: number): ScannerCorners => {
      const lerp = (v0: number, v1: number) => v0 + (v1 - v0) * t;
      return {
        tl: { x: lerp(a.tl.x, b.tl.x), y: lerp(a.tl.y, b.tl.y) },
        tr: { x: lerp(a.tr.x, b.tr.x), y: lerp(a.tr.y, b.tr.y) },
        br: { x: lerp(a.br.x, b.br.x), y: lerp(a.br.y, b.br.y) },
        bl: { x: lerp(a.bl.x, b.bl.x), y: lerp(a.bl.y, b.bl.y) },
      };
    },
    [],
  );

  // Remap corners when snapshot aspect ratio differs from preview
  const remapCornersForPreview = useCallback(
    (corners: ScannerCorners, snapW: number, snapH: number): ScannerCorners => {
      if (layout.width === 0 || layout.height === 0) return corners;
      const snapAR = snapW / snapH;
      const prevAR = layout.width / layout.height;
      if (Math.abs(snapAR - prevAR) / Math.max(snapAR, prevAR) < 0.05) return corners;

      const remap = (c: ScannerCorner): ScannerCorner => {
        if (snapAR > prevAR) {
          // snapshot wider → preview crops left/right
          const visibleFrac = prevAR / snapAR;
          const offset = (1 - visibleFrac) / 2;
          return { x: (c.x - offset) / visibleFrac, y: c.y };
        } else {
          // snapshot taller → preview crops top/bottom
          const visibleFrac = snapAR / prevAR;
          const offset = (1 - visibleFrac) / 2;
          return { x: c.x, y: (c.y - offset) / visibleFrac };
        }
      };
      return { tl: remap(corners.tl), tr: remap(corners.tr), br: remap(corners.br), bl: remap(corners.bl) };
    },
    [layout],
  );

  // Detection loop
  const detectLoop = useCallback(async () => {
    if (!cameraRef.current || isCapturing || detectingRef.current) return;
    detectingRef.current = true;
    try {
      const snap = await cameraRef.current.takePictureAsync({
        quality: 0.3,
        base64: true,
        shutterSound: false,
      });
      if (snap?.base64) {
        let detected: ScannerCorners | null = null;
        try {
          detected = await detectDocument(snap.base64);
        } catch {}

        if (detected) {
          // Aspect ratio correction
          detected = remapCornersForPreview(detected, snap.width, snap.height);
          // Temporal smoothing: lerp with previous corners
          if (lastCornersRef.current) {
            detected = lerpCorners(lastCornersRef.current, detected, 0.6);
          }
          lastCornersRef.current = detected;
          lastDetectTimeRef.current = Date.now();
          setDetectedCorners(detected);
        } else {
          // No detection: keep showing old corners if recent (<1.5s)
          if (lastCornersRef.current && Date.now() - lastDetectTimeRef.current < 1500) {
            setDetectedCorners(lastCornersRef.current);
          } else {
            lastCornersRef.current = null;
            setDetectedCorners(null);
          }
        }
      }
    } catch {
      // detection failed, keep previous corners
    }
    detectingRef.current = false;
    if (!isCapturing) {
      timerRef.current = setTimeout(detectLoop, 400);
    }
  }, [isCapturing, processorRef, lerpCorners, remapCornersForPreview]);

  // Start/stop detection loop based on camera readiness
  useEffect(() => {
    if (cameraReady && !isCapturing) {
      // Small delay before starting detection to let camera warm up
      timerRef.current = setTimeout(detectLoop, 1000);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [cameraReady, isCapturing, detectLoop]);

  const onCameraReady = useCallback(async () => {
    if (cameraRef.current) {
      try {
        const sizes = await cameraRef.current.getAvailablePictureSizesAsync();
        if (sizes.length > 0) {
          // Pick the largest size (highest megapixels)
          let best = sizes[0];
          let bestPixels = 0;
          for (const s of sizes) {
            const parts = s.split('x');
            if (parts.length === 2) {
              const px = parseInt(parts[0], 10) * parseInt(parts[1], 10);
              if (px > bestPixels) {
                bestPixels = px;
                best = s;
              }
            }
          }
          console.log(`[CameraScanner] available sizes: ${sizes.join(', ')}, selected: ${best}`);
          setPictureSize(best);
        }
      } catch {
        // ignore, use default
      }
    }
    setCameraReady(true);
  }, []);

  const capturePhoto = useCallback(async () => {
    if (isCapturing || !cameraRef.current) return;
    setIsCapturing(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    // Wait for any ongoing detection capture to finish
    while (detectingRef.current) {
      await new Promise((r) => setTimeout(r, 50));
    }
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 1,
      });
      if (photo) {
        const base64 = await new File(photo.uri).base64();
        console.log(`[CameraScanner] capture: ${photo.width}x${photo.height}, base64 len: ${base64.length}`);
        onCapture(photo.uri, photo.width, photo.height, detectedCorners, base64);
      }
    } catch {
      setIsCapturing(false);
    }
  }, [isCapturing, detectedCorners, onCapture]);

  const toggleFlash = useCallback(() => {
    setFlash((f) => {
      if (f === 'off') return 'on';
      if (f === 'on') return 'auto';
      return 'off';
    });
  }, []);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    setLayout({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height });
  }, []);

  const flashIcon = flash === 'off' ? 'bolt' : flash === 'on' ? 'bolt' : 'bolt';
  const flashLabel = flash === 'off' ? 'OFF' : flash === 'on' ? 'ON' : 'AUTO';

  // Permission not granted
  if (!permission?.granted) {
    return (
      <View style={styles.centered}>
        <FontAwesome name="camera" size={48} color="#999" />
        <Text style={styles.permissionText}>
          {t('cameraPermission')}
        </Text>
        <TouchableOpacity style={styles.permissionBtn} onPress={requestPermission}>
          <Text style={styles.permissionBtnText}>{t('grantCamera')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.libraryLink} onPress={onPickLibrary}>
          <Text style={styles.libraryLinkText}>{t('selectFromAlbum')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Camera preview */}
      <View style={styles.cameraWrap} onLayout={onLayout}>
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing="back"
          flash={flash}
          animateShutter={false}
          onCameraReady={onCameraReady}
          pictureSize={pictureSize}
        />

        {/* Blue translucent overlay */}
        {detectedCorners && layout.width > 0 && (
          <Svg
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
            width={layout.width}
            height={layout.height}
          >
            <Polygon
              points={`${detectedCorners.tl.x * layout.width},${detectedCorners.tl.y * layout.height} ${detectedCorners.tr.x * layout.width},${detectedCorners.tr.y * layout.height} ${detectedCorners.br.x * layout.width},${detectedCorners.br.y * layout.height} ${detectedCorners.bl.x * layout.width},${detectedCorners.bl.y * layout.height}`}
              fill={OVERLAY_FILL}
              stroke={OVERLAY_STROKE}
              strokeWidth={STROKE_WIDTH}
              strokeLinejoin="round"
            />
          </Svg>
        )}

        {/* Tap-to-capture overlay */}
        <TouchableOpacity
          style={StyleSheet.absoluteFill}
          activeOpacity={1}
          onPress={capturePhoto}
        />

        {/* Hint text */}
        <View style={styles.hintWrap} pointerEvents="none">
          <Text style={styles.hintText}>
            {isCapturing
              ? t('capturing')
              : detectedCorners
                ? t('tapToCapture')
                : t('aimAtDoc')}
          </Text>
        </View>
      </View>

      {/* Bottom controls */}
      <View style={styles.bottomBar}>
        {/* Library button */}
        <TouchableOpacity style={styles.sideBtn} onPress={onPickLibrary}>
          <FontAwesome name="image" size={22} color="#fff" />
          <Text style={styles.sideBtnText}>{t('album')}</Text>
        </TouchableOpacity>

        {/* Shutter button */}
        <TouchableOpacity
          style={styles.shutterOuter}
          onPress={capturePhoto}
          disabled={isCapturing}
          activeOpacity={0.7}
        >
          {isCapturing ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <View style={styles.shutterInner} />
          )}
        </TouchableOpacity>

        {/* Flash button */}
        <TouchableOpacity style={styles.sideBtn} onPress={toggleFlash}>
          <FontAwesome
            name={flashIcon}
            size={22}
            color={flash === 'off' ? '#999' : '#ffd700'}
          />
          <Text style={[styles.sideBtnText, flash !== 'off' && { color: '#ffd700' }]}>
            {flashLabel}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  cameraWrap: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000',
    paddingHorizontal: 32,
  },
  permissionText: {
    color: '#ccc',
    fontSize: 16,
    textAlign: 'center',
    marginTop: 16,
    marginBottom: 24,
  },
  permissionBtn: {
    backgroundColor: '#007aff',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
    marginBottom: 16,
  },
  permissionBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  libraryLink: {
    paddingVertical: 8,
  },
  libraryLinkText: {
    color: '#007aff',
    fontSize: 15,
  },
  hintWrap: {
    position: 'absolute',
    top: 16,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  hintText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    overflow: 'hidden',
  },
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingVertical: 20,
    paddingBottom: 36,
    backgroundColor: '#000',
  },
  sideBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 60,
  },
  sideBtnText: {
    color: '#fff',
    fontSize: 11,
    marginTop: 4,
  },
  shutterOuter: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#fff',
  },
});
