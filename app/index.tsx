import React, { useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  Alert,
  ActivityIndicator,
  ScrollView,
  TouchableOpacity,
  useColorScheme,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { File, Paths, Directory } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import Colors from '@/constants/Colors';
import CornerSelector from '@/components/scanner/CornerSelector';
import ImageProcessor, { ImageProcessorHandle } from '@/components/scanner/ImageProcessor';
import { generatePdf } from '@/services/pdfService';
import type { ScannerCorners, EnhanceMode, ScanResult } from '@/types';

type Step = 'pick' | 'crop' | 'preview';

const ENHANCE_OPTIONS: { key: EnhanceMode; label: string; icon: string }[] = [
  { key: 'bw', label: '黑白', icon: 'file-text-o' },
  { key: 'gray', label: '灰度', icon: 'adjust' },
  { key: 'color', label: '彩色', icon: 'photo' },
];

const DEFAULT_CORNERS: ScannerCorners = {
  tl: { x: 0.1, y: 0.1 },
  tr: { x: 0.9, y: 0.1 },
  br: { x: 0.9, y: 0.9 },
  bl: { x: 0.1, y: 0.9 },
};

export default function ScanScreen() {
  const theme = useColorScheme() ?? 'light';
  const processorRef = useRef<ImageProcessorHandle>(null);

  const [step, setStep] = useState<Step>('pick');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState({ width: 1, height: 1 });
  const [corners, setCorners] = useState<ScannerCorners>(DEFAULT_CORNERS);
  const [enhanceMode, setEnhanceMode] = useState<EnhanceMode>('bw');
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);

  const pickImage = useCallback(async (useCamera: boolean) => {
    try {
      let pickerResult: ImagePicker.ImagePickerResult;
      if (useCamera) {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          Alert.alert('权限不足', '需要相机权限才能拍照');
          return;
        }
        pickerResult = await ImagePicker.launchCameraAsync({
          quality: 1,
          mediaTypes: ['images'],
        });
      } else {
        pickerResult = await ImagePicker.launchImageLibraryAsync({
          quality: 1,
          mediaTypes: ['images'],
        });
      }
      if (pickerResult.canceled || !pickerResult.assets[0]) return;
      const asset = pickerResult.assets[0];
      setImageUri(asset.uri);
      setImageSize({ width: asset.width, height: asset.height });
      setCorners(DEFAULT_CORNERS);
      setResult(null);
      setStep('crop');
    } catch (e: any) {
      Alert.alert('错误', e.message || '选取图片失败');
    }
  }, []);

  const doProcess = useCallback(async () => {
    if (!imageUri || !processorRef.current) return;
    setProcessing(true);
    try {
      const file = new File(imageUri);
      const base64 = await file.base64();
      const scanResult = await processorRef.current.process(base64, corners, enhanceMode);
      setResult(scanResult);
      setStep('preview');
    } catch (e: any) {
      Alert.alert('处理失败', e.message || '图片处理时出错');
    } finally {
      setProcessing(false);
    }
  }, [imageUri, corners, enhanceMode]);

  const savePng = useCallback(async () => {
    if (!result) return;
    try {
      const scansDir = new Directory(Paths.document, 'scans');
      if (!scansDir.exists) {
        scansDir.create();
      }
      const outFile = new File(scansDir, `scan_${Date.now()}.png`);
      outFile.create();
      outFile.write(result.base64, { encoding: 'base64' });
      await Sharing.shareAsync(outFile.uri, { mimeType: 'image/png' });
    } catch (e: any) {
      Alert.alert('保存失败', e.message || '无法保存图片');
    }
  }, [result]);

  const savePdf = useCallback(async () => {
    if (!result) return;
    try {
      const pdfUri = await generatePdf(result.base64, result.width, result.height);
      await Sharing.shareAsync(pdfUri, { mimeType: 'application/pdf' });
    } catch (e: any) {
      Alert.alert('保存失败', e.message || '无法生成 PDF');
    }
  }, [result]);

  const resetToStart = useCallback(() => {
    setStep('pick');
    setImageUri(null);
    setResult(null);
    setCorners(DEFAULT_CORNERS);
  }, []);

  // ── Pick step ──
  const renderPickStep = () => (
    <View style={styles.centered}>
      <View style={[styles.logoCircle, { backgroundColor: Colors[theme].inputBackground }]}>
        <FontAwesome name="file-text-o" size={48} color={Colors[theme].tint} />
      </View>
      <Text style={[styles.title, { color: Colors[theme].text }]}>MiniScan</Text>
      <Text style={[styles.subtitle, { color: Colors[theme].subtleText }]}>
        拍照或从相册选择文档，快速生成扫描件
      </Text>
      <View style={styles.pickButtons}>
        <TouchableOpacity
          style={[styles.pickBtn, { backgroundColor: Colors[theme].tint }]}
          onPress={() => pickImage(true)}
          activeOpacity={0.7}
        >
          <FontAwesome name="camera" size={20} color="#fff" />
          <Text style={styles.pickBtnText}>拍照扫描</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.pickBtn, { backgroundColor: Colors[theme].cardBackground, borderWidth: 1, borderColor: Colors[theme].border }]}
          onPress={() => pickImage(false)}
          activeOpacity={0.7}
        >
          <FontAwesome name="image" size={20} color={Colors[theme].tint} />
          <Text style={[styles.pickBtnText, { color: Colors[theme].text }]}>从相册选择</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  // ── Crop step ──
  const renderCropStep = () => (
    <View style={styles.flex}>
      <View style={styles.cropImageArea}>
        {imageUri && (
          <CornerSelector
            imageUri={imageUri}
            imageWidth={imageSize.width}
            imageHeight={imageSize.height}
            corners={corners}
            onCornersChange={setCorners}
          />
        )}
      </View>

      <View style={[styles.controlPanel, { backgroundColor: Colors[theme].cardBackground }]}>
        <Text style={[styles.controlLabel, { color: Colors[theme].subtleText }]}>增强模式</Text>
        <View style={styles.modeRow}>
          {ENHANCE_OPTIONS.map((opt) => (
            <TouchableOpacity
              key={opt.key}
              style={[
                styles.modeBtn,
                {
                  backgroundColor:
                    enhanceMode === opt.key ? Colors[theme].tint : Colors[theme].inputBackground,
                },
              ]}
              onPress={() => setEnhanceMode(opt.key)}
              activeOpacity={0.7}
            >
              <FontAwesome
                name={opt.icon as any}
                size={16}
                color={enhanceMode === opt.key ? '#fff' : Colors[theme].text}
              />
              <Text
                style={[
                  styles.modeBtnText,
                  { color: enhanceMode === opt.key ? '#fff' : Colors[theme].text },
                ]}
              >
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: Colors[theme].inputBackground }]}
            onPress={resetToStart}
            activeOpacity={0.7}
          >
            <Text style={[styles.actionBtnText, { color: Colors[theme].text }]}>重新选择</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: Colors[theme].tint, opacity: processing ? 0.5 : 1 }]}
            onPress={doProcess}
            disabled={processing}
            activeOpacity={0.7}
          >
            {processing ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={[styles.actionBtnText, { color: '#fff' }]}>开始处理</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );

  // ── Preview step ──
  const renderPreviewStep = () => (
    <View style={styles.flex}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.previewScrollContent}
        maximumZoomScale={3}
        minimumZoomScale={1}
      >
        {result && (
          <Image
            source={{ uri: `data:image/png;base64,${result.base64}` }}
            style={{
              width: '100%',
              aspectRatio: result.width / result.height,
            }}
            resizeMode="contain"
          />
        )}
      </ScrollView>

      <View style={[styles.controlPanel, { backgroundColor: Colors[theme].cardBackground }]}>
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: Colors[theme].inputBackground }]}
            onPress={resetToStart}
            activeOpacity={0.7}
          >
            <FontAwesome name="refresh" size={14} color={Colors[theme].text} style={{ marginRight: 6 }} />
            <Text style={[styles.actionBtnText, { color: Colors[theme].text }]}>重新扫描</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: Colors[theme].inputBackground }]}
            onPress={() => setStep('crop')}
            activeOpacity={0.7}
          >
            <FontAwesome name="crop" size={14} color={Colors[theme].text} style={{ marginRight: 6 }} />
            <Text style={[styles.actionBtnText, { color: Colors[theme].text }]}>返回裁剪</Text>
          </TouchableOpacity>
        </View>
        <View style={[styles.actionRow, { marginTop: 10 }]}>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: Colors[theme].tint }]}
            onPress={savePng}
            activeOpacity={0.7}
          >
            <FontAwesome name="image" size={14} color="#fff" style={{ marginRight: 6 }} />
            <Text style={[styles.actionBtnText, { color: '#fff' }]}>保存 PNG</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: '#ff3b30' }]}
            onPress={savePdf}
            activeOpacity={0.7}
          >
            <FontAwesome name="file-pdf-o" size={14} color="#fff" style={{ marginRight: 6 }} />
            <Text style={[styles.actionBtnText, { color: '#fff' }]}>保存 PDF</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );

  return (
    <View style={[styles.screen, { backgroundColor: Colors[theme].background }]}>
      <ImageProcessor ref={processorRef} />

      {processing && (
        <View style={styles.processingOverlay}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.processingText}>正在处理...</Text>
        </View>
      )}

      {step === 'pick' && renderPickStep()}
      {step === 'crop' && renderCropStep()}
      {step === 'preview' && renderPreviewStep()}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  logoCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  title: { fontSize: 28, fontWeight: '800', marginBottom: 8 },
  subtitle: { fontSize: 15, textAlign: 'center', marginBottom: 40, lineHeight: 22 },
  pickButtons: { width: '100%', gap: 12 },
  pickBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 16,
    borderRadius: 14,
  },
  pickBtnText: { fontSize: 17, fontWeight: '600', color: '#fff' },
  cropImageArea: { flex: 1 },
  controlPanel: {
    padding: 16,
    paddingBottom: 28,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 4,
  },
  controlLabel: { fontSize: 13, marginBottom: 8 },
  modeRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  modeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
  },
  modeBtnText: { fontSize: 14, fontWeight: '600' },
  actionRow: { flexDirection: 'row', gap: 10 },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 12,
  },
  actionBtnText: { fontSize: 16, fontWeight: '600' },
  previewScrollContent: { padding: 16 },
  processingOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  processingText: { color: '#fff', fontSize: 16, marginTop: 12 },
});
