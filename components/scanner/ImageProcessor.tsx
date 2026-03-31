import React, { useRef, useImperativeHandle, forwardRef, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import WebView, { WebViewMessageEvent } from 'react-native-webview';
import { getScannerHtml } from '@/utils/scannerHtml';
import type { ScannerCorners, EnhanceMode, ScanResult, FilterPreviews } from '@/types';

export interface ImageProcessorHandle {
  process(base64: string, corners: ScannerCorners, mode: EnhanceMode): Promise<ScanResult>;
  detect(base64: string): Promise<ScannerCorners | null>;
  previewFilters(base64: string, corners: ScannerCorners): Promise<FilterPreviews>;
}

const ImageProcessor = forwardRef<ImageProcessorHandle, {}>((_props, ref) => {
  const webViewRef = useRef<WebView>(null);
  const pendingRef = useRef<{
    resolve: (r: ScanResult) => void;
    reject: (e: Error) => void;
  } | null>(null);
  const detectPendingRef = useRef<{
    resolve: (r: ScannerCorners | null) => void;
  } | null>(null);
  const filterPreviewsPendingRef = useRef<{
    resolve: (r: FilterPreviews) => void;
    reject: (e: Error) => void;
  } | null>(null);
  const chunksRef = useRef<string[]>([]);
  const chunkMetaRef = useRef<{ total: number; width: number; height: number }>({ total: 0, width: 0, height: 0 });

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'result' && pendingRef.current) {
        console.log(`[ImageProcessor] src=${msg.srcWidth}x${msg.srcHeight} → out=${msg.width}x${msg.height}`);
        pendingRef.current.resolve({
          base64: msg.base64,
          width: msg.width,
          height: msg.height,
        });
        pendingRef.current = null;
      } else if (msg.type === 'resultChunk' && pendingRef.current) {
        if (msg.index === 0) {
          chunksRef.current = new Array(msg.total);
          chunkMetaRef.current = { total: msg.total, width: msg.width, height: msg.height };
        }
        chunksRef.current[msg.index] = msg.data;
        const allReceived = chunksRef.current.length === chunkMetaRef.current.total &&
          chunksRef.current.every((c) => c !== undefined);
        if (allReceived) {
          const fullBase64 = chunksRef.current.join('');
          const { width, height } = chunkMetaRef.current;
          console.log(`[ImageProcessor] chunks assembled → out=${width}x${height}, b64len=${fullBase64.length}`);
          pendingRef.current.resolve({ base64: fullBase64, width, height });
          pendingRef.current = null;
          chunksRef.current = [];
        }
      } else if (msg.type === 'error' && pendingRef.current) {
        pendingRef.current.reject(new Error(msg.message));
        pendingRef.current = null;
      } else if (msg.type === 'corners' && detectPendingRef.current) {
        detectPendingRef.current.resolve(msg.corners ?? null);
        detectPendingRef.current = null;
      } else if (msg.type === 'filterPreviews' && filterPreviewsPendingRef.current) {
        filterPreviewsPendingRef.current.resolve({
          bw: msg.bw,
          gray: msg.gray,
          color: msg.color,
        });
        filterPreviewsPendingRef.current = null;
      } else if (msg.type === 'error' && filterPreviewsPendingRef.current) {
        filterPreviewsPendingRef.current.reject(new Error(msg.message));
        filterPreviewsPendingRef.current = null;
      }
    } catch {
      // ignore parse errors from 'ready' or other messages
    }
  }, []);

  useImperativeHandle(ref, () => ({
    process(base64: string, corners: ScannerCorners, mode: EnhanceMode): Promise<ScanResult> {
      return new Promise((resolve, reject) => {
        if (!webViewRef.current) {
          reject(new Error('WebView not ready'));
          return;
        }
        const timer = setTimeout(() => {
          if (pendingRef.current) {
            pendingRef.current = null;
            chunksRef.current = [];
            reject(new Error('Processing timed out'));
          }
        }, 30000);
        pendingRef.current = {
          resolve: (r) => { clearTimeout(timer); resolve(r); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        };
        // Send base64 via injectJavaScript to avoid iOS postMessage size limits
        const CHUNK = 100000;
        const total = Math.ceil(base64.length / CHUNK);
        for (let i = 0; i < total; i++) {
          const chunk = base64.substring(i * CHUNK, (i + 1) * CHUNK);
          webViewRef.current!.injectJavaScript(
            `receiveProcessChunk(${i},${total},'${chunk}'); true;`
          );
        }
        // Trigger processing after all chunks sent
        const cornersJson = JSON.stringify(corners);
        webViewRef.current!.injectJavaScript(
          `startProcess(${cornersJson},'${mode}'); true;`
        );
      });
    },
    detect(base64: string): Promise<ScannerCorners | null> {
      return new Promise((resolve) => {
        if (!webViewRef.current) {
          resolve(null);
          return;
        }
        detectPendingRef.current = { resolve };
        const payload = JSON.stringify({ type: 'detect', base64 });
        webViewRef.current.postMessage(payload);
      });
    },
    previewFilters(base64: string, corners: ScannerCorners): Promise<FilterPreviews> {
      return new Promise((resolve, reject) => {
        if (!webViewRef.current) {
          reject(new Error('WebView not ready'));
          return;
        }
        filterPreviewsPendingRef.current = { resolve, reject };
        const payload = JSON.stringify({ type: 'previewFilters', base64, corners });
        webViewRef.current.postMessage(payload);
      });
    },
  }));

  return (
    <View style={styles.hidden}>
      <WebView
        ref={webViewRef}
        source={{ html: getScannerHtml() }}
        onMessage={onMessage}
        javaScriptEnabled
        originWhitelist={['*']}
        style={styles.webview}
      />
    </View>
  );
});

ImageProcessor.displayName = 'ImageProcessor';
export default ImageProcessor;

const styles = StyleSheet.create({
  hidden: {
    width: 0,
    height: 0,
    overflow: 'hidden',
    position: 'absolute',
  },
  webview: {
    width: 1,
    height: 1,
  },
});
