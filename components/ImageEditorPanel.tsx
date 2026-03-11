import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  useColorScheme,
  ActivityIndicator,
} from 'react-native';
import WebView, { WebViewMessageEvent } from 'react-native-webview';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useTranslation } from 'react-i18next';
import Colors from '@/constants/Colors';
import ZoomableImage from '@/components/ZoomableImage';
import type { ScanResult } from '@/types';

interface Props {
  result: ScanResult;
  onResultChange: (edited: ScanResult) => void;
  onRescan: () => void;
  onBackToCrop: () => void;
  onSavePng: () => void;
  onSavePdf: () => void;
}

type ToolTab = 'rotate' | 'adjust' | 'filter';

interface FilterPreset {
  key: string;
  labelKey: string;
  brightness: number;
  contrast: number;
  saturation: number;
  warmth: number;
  sepia: number;
  grayscale: number;
}

const FILTER_PRESETS: FilterPreset[] = [
  { key: 'original', labelKey: 'filterOriginal', brightness: 0, contrast: 0, saturation: 0, warmth: 0, sepia: 0, grayscale: 0 },
  { key: 'vivid', labelKey: 'filterVivid', brightness: 5, contrast: 15, saturation: 40, warmth: 0, sepia: 0, grayscale: 0 },
  { key: 'warm', labelKey: 'filterWarm', brightness: 5, contrast: 5, saturation: 10, warmth: 30, sepia: 15, grayscale: 0 },
  { key: 'cool', labelKey: 'filterCool', brightness: 0, contrast: 10, saturation: -10, warmth: -20, sepia: 0, grayscale: 0 },
  { key: 'bw', labelKey: 'filterBW', brightness: 0, contrast: 10, saturation: 0, warmth: 0, sepia: 0, grayscale: 100 },
  { key: 'sepia', labelKey: 'filterSepia', brightness: 0, contrast: 5, saturation: 0, warmth: 0, sepia: 60, grayscale: 0 },
  { key: 'bright', labelKey: 'filterBright', brightness: 25, contrast: 5, saturation: 5, warmth: 0, sepia: 0, grayscale: 0 },
  { key: 'highContrast', labelKey: 'filterHighContrast', brightness: 0, contrast: 40, saturation: 10, warmth: 0, sepia: 0, grayscale: 0 },
];

function getEditorHtml(): string {
  return `<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;background:#000}canvas{display:none}</style>
</head><body>
<canvas id="c"></canvas>
<script>
var canvas = document.getElementById('c');
var ctx = canvas.getContext('2d');
var img = new Image();
var imgLoaded = false;
var imgChunks = [];
var imgChunkTotal = 0;
var MAX_DIM = 2048;

function sendMsg(obj) {
  window.ReactNativeWebView.postMessage(JSON.stringify(obj));
}

function receiveImageChunk(index, total, data) {
  imgChunkTotal = total;
  imgChunks[index] = data;
  var count = 0;
  for (var i = 0; i < total; i++) { if (imgChunks[i]) count++; }
  if (count === total) {
    var b64 = imgChunks.join('');
    imgChunks = [];
    var mime = (b64.charAt(0) === 'i') ? 'image/png' : 'image/jpeg';
    sendMsg({type:'debug', message:'loading ' + mime + ', b64 len=' + b64.length});
    img.onload = function() {
      imgLoaded = true;
      sendMsg({type:'ready', width: img.width, height: img.height});
    };
    img.onerror = function() {
      sendMsg({type:'error', message:'Failed to load image from base64'});
    };
    img.src = 'data:' + mime + ';base64,' + b64;
  }
}

function applyEdits(rotation, brightness, contrast, saturation, warmth, sepia, grayscale) {
  if (!imgLoaded) { sendMsg({type:'error',message:'Image not loaded yet'}); return; }

  try {
    var scale = 1;
    if (img.width > MAX_DIM || img.height > MAX_DIM) {
      scale = MAX_DIM / Math.max(img.width, img.height);
    }
    var sw = Math.round(img.width * scale);
    var sh = Math.round(img.height * scale);

    var isRotated = (rotation === 90 || rotation === 270);
    var w = isRotated ? sh : sw;
    var h = isRotated ? sw : sh;

    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(rotation * Math.PI / 180);
    ctx.drawImage(img, -sw / 2, -sh / 2, sw, sh);
    ctx.restore();

    var needsFilter = brightness !== 0 || contrast !== 0 || saturation !== 0 || warmth !== 0 || sepia > 0 || grayscale > 0;
    if (needsFilter) {
      var imageData = ctx.getImageData(0, 0, w, h);
      var d = imageData.data;
      var len = d.length;
      var bF = 1 + brightness / 100;
      var cF = 1 + contrast / 100;
      var sF = 1 + saturation / 100;
      var wS = warmth * 0.5;
      var gF = grayscale / 100;
      var sepF = sepia / 100;

      for (var p = 0; p < len; p += 4) {
        var r = d[p], g = d[p+1], b = d[p+2];
        if (bF !== 1) { r *= bF; g *= bF; b *= bF; }
        if (cF !== 1) { r = (r - 128) * cF + 128; g = (g - 128) * cF + 128; b = (b - 128) * cF + 128; }
        if (sF !== 1) { var gr = 0.2126 * r + 0.7152 * g + 0.0722 * b; r = gr + (r - gr) * sF; g = gr + (g - gr) * sF; b = gr + (b - gr) * sF; }
        if (wS !== 0) { r += wS; b -= wS; }
        if (gF > 0) { var gv = 0.2126 * r + 0.7152 * g + 0.0722 * b; r = r + (gv - r) * gF; g = g + (gv - g) * gF; b = b + (gv - b) * gF; }
        if (sepF > 0) { var sr = r*0.393+g*0.769+b*0.189; var sg = r*0.349+g*0.686+b*0.168; var sb = r*0.272+g*0.534+b*0.131; r = r+(sr-r)*sepF; g = g+(sg-g)*sepF; b = b+(sb-b)*sepF; }
        d[p] = r < 0 ? 0 : r > 255 ? 255 : r;
        d[p+1] = g < 0 ? 0 : g > 255 ? 255 : g;
        d[p+2] = b < 0 ? 0 : b > 255 ? 255 : b;
      }
      ctx.putImageData(imageData, 0, 0);
    }

    var dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    var b64 = dataUrl.replace(/^data:image\\/[^;]+;base64,/, '');
    if (!b64 || b64.length < 100) {
      sendMsg({type:'error', message:'toDataURL returned empty result'});
      return;
    }

    var CHUNK = 512000;
    if (b64.length > CHUNK) {
      var total = Math.ceil(b64.length / CHUNK);
      for (var i = 0; i < total; i++) {
        sendMsg({type:'chunk', index: i, total: total, data: b64.substr(i * CHUNK, CHUNK), width: w, height: h});
      }
    } else {
      sendMsg({type:'result', base64: b64, width: w, height: h});
    }
  } catch(e) {
    sendMsg({type:'error', message:'applyEdits: ' + e.message});
  }
}

sendMsg({type:'webview_init'});
</script></body></html>`;
}

export default function ImageEditorPanel({ result, onResultChange, onRescan, onBackToCrop, onSavePng, onSavePdf }: Props) {
  const theme = useColorScheme() ?? 'light';
  const { t } = useTranslation();
  const webViewRef = useRef<WebView>(null);

  const [activeTab, setActiveTab] = useState<ToolTab>('filter');
  const [rotation, setRotation] = useState(0);
  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast] = useState(0);
  const [saturation, setSaturation] = useState(0);
  const [warmth, setWarmth] = useState(0);
  const [sepia, setSepia] = useState(0);
  const [grayscale, setGrayscale] = useState(0);
  const [activeFilter, setActiveFilter] = useState('original');
  const [previewUri, setPreviewUri] = useState(`data:image/jpeg;base64,${result.base64}`);
  const [previewSize, setPreviewSize] = useState({ width: result.width, height: result.height });
  const [processing, setProcessing] = useState(false);
  const [webviewReady, setWebviewReady] = useState(false);

  const editCountRef = useRef(0);

  const applyEdits = useCallback(() => {
    if (!webViewRef.current || !webviewReady) return;
    setProcessing(true);
    const js = `applyEdits(${rotation},${brightness},${contrast},${saturation},${warmth},${sepia},${grayscale}); true;`;
    webViewRef.current.injectJavaScript(js);
  }, [rotation, brightness, contrast, saturation, warmth, sepia, grayscale, webviewReady]);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!webviewReady) return;
    editCountRef.current++;
    if (editCountRef.current <= 1) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { applyEdits(); }, 150);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [rotation, brightness, contrast, saturation, warmth, sepia, grayscale, webviewReady]);

  const chunksRef = useRef<string[]>([]);
  const chunkMetaRef = useRef<{ total: number; width: number; height: number }>({ total: 0, width: 0, height: 0 });

  const sendImageToWebView = useCallback(() => {
    if (!webViewRef.current) return;
    const b64 = result.base64;
    const CHUNK = 100000;
    const total = Math.ceil(b64.length / CHUNK);
    for (let i = 0; i < total; i++) {
      const chunk = b64.substring(i * CHUNK, (i + 1) * CHUNK);
      webViewRef.current.injectJavaScript(`receiveImageChunk(${i},${total},'${chunk}'); true;`);
    }
  }, [result.base64]);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'debug') {
        console.log(`[ImageEditorPanel] WebView: ${msg.message}`);
      } else if (msg.type === 'webview_init') {
        console.log('[ImageEditorPanel] WebView init, sending image...');
        sendImageToWebView();
      } else if (msg.type === 'ready') {
        console.log(`[ImageEditorPanel] Image ready: ${msg.width}x${msg.height}`);
        setWebviewReady(true);
      } else if (msg.type === 'result') {
        setPreviewUri(`data:image/jpeg;base64,${msg.base64}`);
        setPreviewSize({ width: msg.width, height: msg.height });
        setProcessing(false);
        onResultChange({ base64: msg.base64, width: msg.width, height: msg.height });
      } else if (msg.type === 'chunk') {
        if (msg.index === 0) {
          chunksRef.current = new Array(msg.total);
          chunkMetaRef.current = { total: msg.total, width: msg.width, height: msg.height };
        }
        chunksRef.current[msg.index] = msg.data;
        // Check if all chunks received
        const allReceived = chunksRef.current.length === chunkMetaRef.current.total &&
          chunksRef.current.every((c) => c !== undefined);
        if (allReceived) {
          const fullBase64 = chunksRef.current.join('');
          const { width, height } = chunkMetaRef.current;
          setPreviewUri(`data:image/jpeg;base64,${fullBase64}`);
          setPreviewSize({ width, height });
          setProcessing(false);
          onResultChange({ base64: fullBase64, width, height });
          chunksRef.current = [];
        }
      } else if (msg.type === 'error') {
        console.error(`[ImageEditorPanel] WebView error: ${msg.message}`);
        setProcessing(false);
      }
    } catch (e) {
      console.error('[ImageEditorPanel] onMessage parse error:', e);
    }
  }, [onResultChange, sendImageToWebView]);

  const handleRotateCW = useCallback(() => {
    setRotation((r) => (r + 90) % 360);
  }, []);

  const handleRotateCCW = useCallback(() => {
    setRotation((r) => (r + 270) % 360);
  }, []);

  const handleFilterSelect = useCallback((preset: FilterPreset) => {
    setActiveFilter(preset.key);
    setBrightness(preset.brightness);
    setContrast(preset.contrast);
    setSaturation(preset.saturation);
    setWarmth(preset.warmth);
    setSepia(preset.sepia);
    setGrayscale(preset.grayscale);
  }, []);

  const adjustValue = useCallback((
    setter: React.Dispatch<React.SetStateAction<number>>,
    delta: number, min: number, max: number,
  ) => {
    setter((v) => Math.min(max, Math.max(min, v + delta)));
    setActiveFilter('custom');
  }, []);

  const renderAdjustRow = (
    label: string, value: number,
    setter: React.Dispatch<React.SetStateAction<number>>,
    min: number, max: number, step: number,
  ) => (
    <View style={styles.adjustRow} key={label}>
      <Text style={[styles.adjustLabel, { color: Colors[theme].text }]}>{label}</Text>
      <TouchableOpacity
        style={[styles.adjustBtn, { backgroundColor: Colors[theme].inputBackground }]}
        onPress={() => adjustValue(setter, -step, min, max)}
      >
        <FontAwesome name="minus" size={12} color={Colors[theme].text} />
      </TouchableOpacity>
      <View style={styles.adjustValueContainer}>
        <View style={[styles.adjustBar, { backgroundColor: Colors[theme].inputBackground }]}>
          <View style={[styles.adjustBarFill, { backgroundColor: Colors[theme].tint, width: `${((value - min) / (max - min)) * 100}%` }]} />
        </View>
        <Text style={[styles.adjustValueText, { color: Colors[theme].subtleText }]}>{value}</Text>
      </View>
      <TouchableOpacity
        style={[styles.adjustBtn, { backgroundColor: Colors[theme].inputBackground }]}
        onPress={() => adjustValue(setter, step, min, max)}
      >
        <FontAwesome name="plus" size={12} color={Colors[theme].text} />
      </TouchableOpacity>
    </View>
  );

  const renderToolContent = () => {
    switch (activeTab) {
      case 'rotate':
        return (
          <View style={styles.rotateContent}>
            <TouchableOpacity
              style={[styles.rotateBtn, { backgroundColor: Colors[theme].inputBackground }]}
              onPress={handleRotateCCW}
              activeOpacity={0.7}
            >
              <FontAwesome name="rotate-left" size={24} color={Colors[theme].tint} />
              <Text style={[styles.rotateBtnText, { color: Colors[theme].text }]}>-90°</Text>
            </TouchableOpacity>
            <Text style={[styles.rotateInfo, { color: Colors[theme].subtleText }]}>{rotation}°</Text>
            <TouchableOpacity
              style={[styles.rotateBtn, { backgroundColor: Colors[theme].inputBackground }]}
              onPress={handleRotateCW}
              activeOpacity={0.7}
            >
              <FontAwesome name="rotate-right" size={24} color={Colors[theme].tint} />
              <Text style={[styles.rotateBtnText, { color: Colors[theme].text }]}>+90°</Text>
            </TouchableOpacity>
          </View>
        );
      case 'adjust':
        return (
          <View style={styles.adjustContent}>
            {renderAdjustRow(t('brightness'), brightness, setBrightness, -50, 50, 5)}
            {renderAdjustRow(t('contrastAdj'), contrast, setContrast, -50, 50, 5)}
            {renderAdjustRow(t('saturationAdj'), saturation, setSaturation, -50, 50, 5)}
          </View>
        );
      case 'filter':
        return (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterScroll}>
            {FILTER_PRESETS.map((preset) => {
              const isActive = activeFilter === preset.key;
              return (
                <TouchableOpacity
                  key={preset.key}
                  style={[styles.filterItem, { borderColor: isActive ? Colors[theme].tint : 'transparent' }]}
                  onPress={() => handleFilterSelect(preset)}
                  activeOpacity={0.7}
                >
                  <View style={[styles.filterThumb, { backgroundColor: Colors[theme].inputBackground }]}>
                    <FontAwesome name="image" size={18} color={isActive ? Colors[theme].tint : Colors[theme].subtleText} />
                  </View>
                  <Text style={[styles.filterLabel, { color: isActive ? Colors[theme].tint : Colors[theme].subtleText }]} numberOfLines={1}>
                    {t(preset.labelKey)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        );
    }
  };

  const tabs: { key: ToolTab; labelKey: string; icon: string }[] = [
    { key: 'rotate', labelKey: 'tabRotate', icon: 'rotate-right' },
    { key: 'adjust', labelKey: 'tabAdjust', icon: 'sliders' },
    { key: 'filter', labelKey: 'tabFilter', icon: 'magic' },
  ];

  return (
    <View style={styles.container}>
      <View style={styles.hidden}>
        <WebView
          ref={webViewRef}
          source={{ html: getEditorHtml() }}
          onMessage={onMessage}
          javaScriptEnabled
          originWhitelist={['*']}
          style={styles.webview}
        />
      </View>

      {/* Image preview with pinch-to-zoom */}
      <View style={styles.previewArea}>
        <ZoomableImage
          uri={previewUri}
          aspectRatio={previewSize.width / previewSize.height}
        />
        {processing && (
          <View style={styles.processingOverlay}>
            <ActivityIndicator color="#fff" size="small" />
          </View>
        )}
      </View>

      {/* Bottom panel */}
      <View style={[styles.panel, { backgroundColor: Colors[theme].cardBackground }]}>
        {/* Tab bar */}
        <View style={styles.tabBar}>
          {tabs.map((tab) => {
            const isActive = activeTab === tab.key;
            return (
              <TouchableOpacity
                key={tab.key}
                style={[styles.tab, { borderBottomColor: isActive ? Colors[theme].tint : 'transparent' }]}
                onPress={() => setActiveTab(tab.key)}
                activeOpacity={0.7}
              >
                <FontAwesome name={tab.icon as any} size={15} color={isActive ? Colors[theme].tint : Colors[theme].subtleText} />
                <Text style={[styles.tabText, { color: isActive ? Colors[theme].tint : Colors[theme].subtleText }]}>{t(tab.labelKey)}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Tool content */}
        <View style={styles.toolContent}>{renderToolContent()}</View>

        {/* Action buttons */}
        <View style={styles.actionRow}>
          <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors[theme].inputBackground }]} onPress={onRescan} activeOpacity={0.7}>
            <FontAwesome name="refresh" size={13} color={Colors[theme].text} style={{ marginRight: 5 }} />
            <Text style={[styles.actionBtnText, { color: Colors[theme].text }]}>{t('rescan')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors[theme].inputBackground }]} onPress={onBackToCrop} activeOpacity={0.7}>
            <FontAwesome name="crop" size={13} color={Colors[theme].text} style={{ marginRight: 5 }} />
            <Text style={[styles.actionBtnText, { color: Colors[theme].text }]}>{t('backToCrop')}</Text>
          </TouchableOpacity>
        </View>
        <View style={[styles.actionRow, { marginTop: 8 }]}>
          <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors[theme].tint }]} onPress={onSavePng} activeOpacity={0.7}>
            <FontAwesome name="image" size={13} color="#fff" style={{ marginRight: 5 }} />
            <Text style={[styles.actionBtnText, { color: '#fff' }]}>{t('savePng')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.actionBtn, { backgroundColor: '#ff3b30' }]} onPress={onSavePdf} activeOpacity={0.7}>
            <FontAwesome name="file-pdf-o" size={13} color="#fff" style={{ marginRight: 5 }} />
            <Text style={[styles.actionBtnText, { color: '#fff' }]}>{t('savePdf')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  hidden: { width: 300, height: 300, overflow: 'hidden', position: 'absolute', left: -9999, top: -9999 },
  webview: { width: 300, height: 300 },
  previewArea: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 8,
  },
  processingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  panel: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 4,
    paddingBottom: 24,
  },
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(128,128,128,0.2)',
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 10,
    borderBottomWidth: 2,
  },
  tabText: { fontSize: 12, fontWeight: '600' },
  toolContent: { minHeight: 70, paddingHorizontal: 12, paddingVertical: 8 },
  rotateContent: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16 },
  rotateBtn: { alignItems: 'center', justifyContent: 'center', padding: 14, borderRadius: 12, gap: 4 },
  rotateBtnText: { fontSize: 12, fontWeight: '500' },
  rotateInfo: { fontSize: 15, fontWeight: '600' },
  adjustContent: { gap: 8 },
  adjustRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  adjustLabel: { width: 50, fontSize: 11, fontWeight: '500' },
  adjustBtn: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  adjustValueContainer: { flex: 1, alignItems: 'center', gap: 2 },
  adjustBar: { width: '100%', height: 4, borderRadius: 2, overflow: 'hidden' },
  adjustBarFill: { height: '100%', borderRadius: 2 },
  adjustValueText: { fontSize: 10 },
  filterScroll: { flexGrow: 0 },
  filterItem: { alignItems: 'center', marginRight: 10, borderWidth: 2, borderRadius: 10, padding: 3 },
  filterThumb: { width: 46, height: 46, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  filterLabel: { fontSize: 10, marginTop: 2, fontWeight: '500' },
  actionRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 12 },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 10,
  },
  actionBtnText: { fontSize: 14, fontWeight: '600' },
});
