import React, { useState, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Image,
  StyleSheet,
  PanResponder,
  LayoutChangeEvent,
  GestureResponderEvent,
} from 'react-native';
import type { ScannerCorners, ScannerCorner } from '@/types';

const HANDLE_SIZE = 36;
const HANDLE_HIT_RADIUS = 60;
const MAGNIFIER_SIZE = 120;
const MAGNIFIER_ZOOM = 3;
const MAGNIFIER_OFFSET_Y = -80; // show above touch point

interface CornerSelectorProps {
  imageUri: string;
  imageWidth: number;
  imageHeight: number;
  corners: ScannerCorners;
  onCornersChange: (corners: ScannerCorners) => void;
}

type CornerKey = 'tl' | 'tr' | 'br' | 'bl';
const CORNER_KEYS: CornerKey[] = ['tl', 'tr', 'br', 'bl'];

export default function CornerSelector({
  imageUri,
  imageWidth,
  imageHeight,
  corners,
  onCornersChange,
}: CornerSelectorProps) {
  const [layout, setLayout] = useState({ width: 0, height: 0 });
  const activeCornerRef = useRef<CornerKey | null>(null);
  const [activeCorner, setActiveCorner] = useState<CornerKey | null>(null);

  // Use refs so PanResponder always sees the latest values
  const cornersRef = useRef(corners);
  cornersRef.current = corners;
  const onCornersChangeRef = useRef(onCornersChange);
  onCornersChangeRef.current = onCornersChange;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const imageAspect = imageWidth / imageHeight;

  // Compute display dimensions for rendering
  const layoutAspect = layout.width / layout.height || 1;
  let displayW: number, displayH: number, offsetX: number, offsetY: number;
  if (imageAspect > layoutAspect) {
    displayW = layout.width;
    displayH = layout.width / imageAspect;
    offsetX = 0;
    offsetY = (layout.height - displayH) / 2;
  } else {
    displayH = layout.height;
    displayW = layout.height * imageAspect;
    offsetX = (layout.width - displayW) / 2;
    offsetY = 0;
  }

  // Helper functions that read from refs (stable references)
  const getDisplayMetrics = useCallback(() => {
    const l = layoutRef.current;
    const la = l.width / l.height || 1;
    let dw: number, dh: number, ox: number, oy: number;
    if (imageAspect > la) {
      dw = l.width;
      dh = l.width / imageAspect;
      ox = 0;
      oy = (l.height - dh) / 2;
    } else {
      dh = l.height;
      dw = l.height * imageAspect;
      ox = (l.width - dw) / 2;
      oy = 0;
    }
    return { dw, dh, ox, oy };
  }, [imageAspect]);

  const toScreen = useCallback(
    (c: ScannerCorner) => {
      const { dw, dh, ox, oy } = getDisplayMetrics();
      return { x: ox + c.x * dw, y: oy + c.y * dh };
    },
    [getDisplayMetrics],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt: GestureResponderEvent) => {
          const { locationX, locationY } = evt.nativeEvent;
          const { dw, dh, ox, oy } = getDisplayMetrics();

          // Find closest corner
          let best: CornerKey | null = null;
          let bestDist = Infinity;
          for (const key of CORNER_KEYS) {
            const c = cornersRef.current[key];
            const sx = ox + c.x * dw;
            const sy = oy + c.y * dh;
            const d = Math.hypot(sx - locationX, sy - locationY);
            if (d < bestDist && d < HANDLE_HIT_RADIUS) {
              bestDist = d;
              best = key;
            }
          }
          activeCornerRef.current = best;
          setActiveCorner(best);
        },
        onPanResponderMove: (evt: GestureResponderEvent) => {
          const key = activeCornerRef.current;
          if (!key) return;
          const { locationX, locationY } = evt.nativeEvent;
          const { dw, dh, ox, oy } = getDisplayMetrics();

          const normalized: ScannerCorner = {
            x: Math.max(0, Math.min(1, (locationX - ox) / (dw || 1))),
            y: Math.max(0, Math.min(1, (locationY - oy) / (dh || 1))),
          };
          onCornersChangeRef.current({
            ...cornersRef.current,
            [key]: normalized,
          });
        },
        onPanResponderRelease: () => {
          activeCornerRef.current = null;
          setActiveCorner(null);
        },
      }),
    [getDisplayMetrics],
  );

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    setLayout({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height });
  }, []);

  const renderLine = (from: ScannerCorner, to: ScannerCorner, key: string) => {
    const s1 = toScreen(from);
    const s2 = toScreen(to);
    const length = Math.hypot(s2.x - s1.x, s2.y - s1.y);
    const angle = Math.atan2(s2.y - s1.y, s2.x - s1.x);
    return (
      <View
        key={key}
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: s1.x,
          top: s1.y - 1,
          width: length,
          height: 2,
          backgroundColor: '#007aff',
          transformOrigin: 'left center',
          transform: [{ rotate: `${angle}rad` }],
        }}
      />
    );
  };

  const renderHandle = (key: CornerKey) => {
    const sc = toScreen(corners[key]);
    const isActive = activeCorner === key;
    return (
      <View
        key={key}
        pointerEvents="none"
        style={[
          styles.handle,
          {
            left: sc.x - HANDLE_SIZE / 2,
            top: sc.y - HANDLE_SIZE / 2,
          },
        ]}
      >
        <View style={[styles.handleInner, isActive && styles.handleInnerActive]} />
      </View>
    );
  };

  // Magnifier: shows a zoomed-in circle around the active corner
  const renderMagnifier = () => {
    if (!activeCorner || displayW <= 0 || displayH <= 0) return null;

    const corner = corners[activeCorner];
    const sc = toScreen(corner);

    // Position magnifier above the touch point, keep it within bounds
    let magX = sc.x - MAGNIFIER_SIZE / 2;
    let magY = sc.y + MAGNIFIER_OFFSET_Y - MAGNIFIER_SIZE / 2;

    // If magnifier would go above viewport, show it below instead
    if (magY < 0) {
      magY = sc.y + 60 - MAGNIFIER_SIZE / 2;
    }
    // Keep within horizontal bounds
    magX = Math.max(4, Math.min(layout.width - MAGNIFIER_SIZE - 4, magX));

    // Calculate the zoomed image dimensions and position
    // The image inside magnifier is scaled by MAGNIFIER_ZOOM
    const zoomedW = displayW * MAGNIFIER_ZOOM;
    const zoomedH = displayH * MAGNIFIER_ZOOM;

    // Center the magnifier on the corner point in the zoomed image
    const imgLeft = MAGNIFIER_SIZE / 2 - (corner.x * zoomedW);
    const imgTop = MAGNIFIER_SIZE / 2 - (corner.y * zoomedH);

    return (
      <View
        pointerEvents="none"
        style={[
          styles.magnifier,
          {
            left: magX,
            top: magY,
          },
        ]}
      >
        <Image
          source={{ uri: imageUri }}
          style={{
            position: 'absolute',
            left: imgLeft,
            top: imgTop,
            width: zoomedW,
            height: zoomedH,
          }}
          resizeMode="stretch"
        />
        {/* Crosshair */}
        <View style={styles.crosshairH} />
        <View style={styles.crosshairV} />
      </View>
    );
  };

  const pairs: [CornerKey, CornerKey][] = [
    ['tl', 'tr'],
    ['tr', 'br'],
    ['br', 'bl'],
    ['bl', 'tl'],
  ];

  return (
    <View style={styles.container} onLayout={onLayout}>
      {layout.width > 0 && (
        <>
          <Image
            source={{ uri: imageUri }}
            style={{
              position: 'absolute',
              left: offsetX,
              top: offsetY,
              width: displayW,
              height: displayH,
            }}
            resizeMode="stretch"
          />
          <View style={StyleSheet.absoluteFill} {...panResponder.panHandlers}>
            {pairs.map(([a, b]) => renderLine(corners[a], corners[b], `${a}-${b}`))}
            {CORNER_KEYS.map(renderHandle)}
          </View>
          {renderMagnifier()}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  handle: {
    position: 'absolute',
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handleInner: {
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    borderRadius: HANDLE_SIZE / 2,
    backgroundColor: 'rgba(0,122,255,0.5)',
    borderWidth: 3,
    borderColor: '#007aff',
  },
  handleInnerActive: {
    backgroundColor: 'rgba(0,122,255,0.7)',
    borderWidth: 4,
    transform: [{ scale: 1.2 }],
  },
  magnifier: {
    position: 'absolute',
    width: MAGNIFIER_SIZE,
    height: MAGNIFIER_SIZE,
    borderRadius: MAGNIFIER_SIZE / 2,
    overflow: 'hidden',
    borderWidth: 3,
    borderColor: '#007aff',
    backgroundColor: '#000',
    // Shadow
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 6,
    elevation: 8,
  },
  crosshairH: {
    position: 'absolute',
    top: MAGNIFIER_SIZE / 2 - 0.5,
    left: MAGNIFIER_SIZE / 2 - 12,
    width: 24,
    height: 1,
    backgroundColor: 'rgba(255,0,0,0.7)',
  },
  crosshairV: {
    position: 'absolute',
    left: MAGNIFIER_SIZE / 2 - 0.5,
    top: MAGNIFIER_SIZE / 2 - 12,
    width: 1,
    height: 24,
    backgroundColor: 'rgba(255,0,0,0.7)',
  },
});
