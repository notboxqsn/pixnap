import React, { useRef, useImperativeHandle, forwardRef, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import WebView, { WebViewMessageEvent } from 'react-native-webview';
import { getScannerHtml } from '@/utils/scannerHtml';
import type { ScannerCorners, EnhanceMode, ScanResult } from '@/types';

export interface ImageProcessorHandle {
  process(base64: string, corners: ScannerCorners, mode: EnhanceMode): Promise<ScanResult>;
}

const ImageProcessor = forwardRef<ImageProcessorHandle, {}>((_props, ref) => {
  const webViewRef = useRef<WebView>(null);
  const pendingRef = useRef<{
    resolve: (r: ScanResult) => void;
    reject: (e: Error) => void;
  } | null>(null);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'result' && pendingRef.current) {
        pendingRef.current.resolve({
          base64: msg.base64,
          width: msg.width,
          height: msg.height,
        });
        pendingRef.current = null;
      } else if (msg.type === 'error' && pendingRef.current) {
        pendingRef.current.reject(new Error(msg.message));
        pendingRef.current = null;
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
        pendingRef.current = { resolve, reject };
        const payload = JSON.stringify({
          type: 'process',
          base64,
          corners,
          mode,
        });
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
