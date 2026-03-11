import React, { useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  Alert,
  ActivityIndicator,
  TouchableOpacity,
  useColorScheme,
  Modal,
  FlatList,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { File, Paths, Directory } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as MediaLibrary from 'expo-media-library';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useTranslation } from 'react-i18next';
import Colors from '@/constants/Colors';
import CornerSelector from '@/components/scanner/CornerSelector';
import ImageProcessor, { ImageProcessorHandle } from '@/components/scanner/ImageProcessor';
import { generatePdf } from '@/services/pdfService';
import { checkAndShowAd } from '@/services/adService';
import { detectDocument } from '@/modules/document-detection/src';
import { SUPPORTED_LANGUAGES, changeLanguage } from '@/i18n';
import CameraScanner from '@/components/scanner/CameraScanner';
import ZoomableImage from '@/components/ZoomableImage';
import ImageEditorPanel from '@/components/ImageEditorPanel';
import type { ScannerCorners, EnhanceMode, ScanResult } from '@/types';

type Step = 'home' | 'camera' | 'crop' | 'preview';

const DEFAULT_CORNERS: ScannerCorners = {
  tl: { x: 0.1, y: 0.1 },
  tr: { x: 0.9, y: 0.1 },
  br: { x: 0.9, y: 0.9 },
  bl: { x: 0.1, y: 0.9 },
};

const FULL_CORNERS: ScannerCorners = {
  tl: { x: 0, y: 0 },
  tr: { x: 1, y: 0 },
  br: { x: 1, y: 1 },
  bl: { x: 0, y: 1 },
};

export default function ScanScreen() {
  const theme = useColorScheme() ?? 'light';
  const { t, i18n } = useTranslation();
  const processorRef = useRef<ImageProcessorHandle>(null);

  const [step, setStep] = useState<Step>('home');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState({ width: 1, height: 1 });
  const [corners, setCorners] = useState<ScannerCorners>(DEFAULT_CORNERS);
  const enhanceMode: EnhanceMode = 'color';
  const [processing, setProcessing] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [nativeScan, setNativeScan] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [langModalVisible, setLangModalVisible] = useState(false);
  const base64Ref = useRef<string | null>(null);

  const handleAssetPicked = useCallback(async (asset: ImagePicker.ImagePickerAsset) => {
    setImageUri(asset.uri);
    setImageSize({ width: asset.width, height: asset.height });
    setCorners(DEFAULT_CORNERS);
    setResult(null);
    setNativeScan(false);
    setStep('crop');
    setDetecting(true);
    try {
      const file = new File(asset.uri);
      const b64 = await file.base64();
      base64Ref.current = b64;
      try {
        const nativeCorners = await detectDocument(b64);
        if (nativeCorners) {
          setCorners(nativeCorners);
        }
      } catch (e) {
        console.warn('[Pixnap] ONNX detection failed:', e);
      }
    } catch {
      // detection failed silently, keep default corners
    } finally {
      setDetecting(false);
    }
  }, []);

  const handleNativeScan = useCallback(async () => {
    try {
      await checkAndShowAd();
      const pickerResult = await ImagePicker.launchCameraAsync({
        quality: 1,
        mediaTypes: ['images'],
      });
      if (pickerResult.canceled || !pickerResult.assets[0]) return;
      await handleAssetPicked(pickerResult.assets[0]);
    } catch (e: any) {
      Alert.alert(t('scanFailed'), e.message || t('scanFailedMsg'));
    }
  }, [t, handleAssetPicked]);

  const handleCameraCapture = useCallback(
    async (uri: string, width: number, height: number, corners: ScannerCorners | null, base64: string) => {
      setImageUri(uri);
      setImageSize({ width, height });
      setResult(null);
      setNativeScan(false);
      base64Ref.current = base64;
      setStep('crop');
      setDetecting(true);
      try {
        // Use ONNX native detection on the full-res capture
        const nativeCorners = await detectDocument(base64);
        if (nativeCorners) {
          setCorners(nativeCorners);
        } else if (corners) {
          // Fall back to live-preview corners if available
          setCorners(corners);
        } else {
          setCorners(DEFAULT_CORNERS);
        }
      } catch {
        setCorners(corners ?? DEFAULT_CORNERS);
      } finally {
        setDetecting(false);
      }
    },
    [],
  );

  const handlePickLibrary = useCallback(async () => {
    try {
      await checkAndShowAd();
      const pickerResult = await ImagePicker.launchImageLibraryAsync({
        quality: 1,
        mediaTypes: ['images'],
      });
      if (pickerResult.canceled || !pickerResult.assets[0]) return;
      await handleAssetPicked(pickerResult.assets[0]);
    } catch (e: any) {
      Alert.alert(t('error'), e.message || t('pickImageFailed'));
    }
  }, [t, handleAssetPicked]);

  const doProcess = useCallback(async () => {
    if (!imageUri || !processorRef.current) return;
    setProcessing(true);
    try {
      let base64 = base64Ref.current;
      if (!base64) {
        const file = new File(imageUri);
        base64 = await file.base64();
        base64Ref.current = base64;
      }
      const scanResult = await processorRef.current.process(base64, corners, enhanceMode);
      setResult(scanResult);
      setStep('preview');
    } catch (e: any) {
      Alert.alert(t('processFailed'), e.message || t('processFailedMsg'));
    } finally {
      setProcessing(false);
    }
  }, [imageUri, corners, enhanceMode, t]);

  const savePng = useCallback(async () => {
    if (!result) return;
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(t('saveFailed'), t('saveImageFailed'));
        return;
      }
      const scansDir = new Directory(Paths.document, 'scans');
      if (!scansDir.exists) {
        scansDir.create();
      }
      const outFile = new File(scansDir, `scan_${Date.now()}.png`);
      outFile.create();
      outFile.write(result.base64, { encoding: 'base64' });
      await MediaLibrary.saveToLibraryAsync(outFile.uri);
      Alert.alert(t('savedSuccess'), t('imageSaved'));
    } catch (e: any) {
      Alert.alert(t('saveFailed'), e.message || t('saveImageFailed'));
    }
  }, [result, t]);

  const savePdf = useCallback(async () => {
    if (!result) return;
    try {
      const pdfUri = await generatePdf(result.base64, result.width, result.height);
      await Sharing.shareAsync(pdfUri, { mimeType: 'application/pdf' });
    } catch (e: any) {
      Alert.alert(t('saveFailed'), e.message || t('savePdfFailed'));
    }
  }, [result, t]);

  const handleEditorResult = useCallback((edited: ScanResult) => {
    setResult(edited);
  }, []);

  const resetToStart = useCallback(() => {
    setStep('home');
    setImageUri(null);
    setResult(null);
    setNativeScan(false);
    setCorners(DEFAULT_CORNERS);
    base64Ref.current = null;
  }, []);

  const handleLanguageSelect = useCallback(async (code: string) => {
    setLangModalVisible(false);
    await changeLanguage(code);
  }, []);

  // ── Language selector modal ──
  const renderLanguageModal = () => (
    <Modal
      visible={langModalVisible}
      transparent
      animationType="fade"
      onRequestClose={() => setLangModalVisible(false)}
    >
      <TouchableOpacity
        style={styles.modalOverlay}
        activeOpacity={1}
        onPress={() => setLangModalVisible(false)}
      >
        <View style={[styles.modalContent, { backgroundColor: Colors[theme].cardBackground }]}>
          <Text style={[styles.modalTitle, { color: Colors[theme].text }]}>{t('language')}</Text>
          <FlatList
            data={SUPPORTED_LANGUAGES}
            keyExtractor={(item) => item.code}
            renderItem={({ item }) => {
              const isSelected = i18n.language === item.code;
              return (
                <TouchableOpacity
                  style={[
                    styles.langItem,
                    {
                      backgroundColor: isSelected
                        ? Colors[theme].tint + '15'
                        : 'transparent',
                    },
                  ]}
                  onPress={() => handleLanguageSelect(item.code)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.langFlag}>{item.flag}</Text>
                  <Text
                    style={[
                      styles.langLabel,
                      {
                        color: isSelected ? Colors[theme].tint : Colors[theme].text,
                        fontWeight: isSelected ? '700' : '400',
                      },
                    ]}
                  >
                    {item.label}
                  </Text>
                  {isSelected && (
                    <FontAwesome name="check" size={16} color={Colors[theme].tint} />
                  )}
                </TouchableOpacity>
              );
            }}
          />
        </View>
      </TouchableOpacity>
    </Modal>
  );

  // ── Home step ──
  const renderHomeStep = () => (
    <View style={styles.cameraStep}>
      <View style={styles.cameraStepContent}>
        <FontAwesome name="file-text-o" size={64} color={Colors[theme].subtleText} />
        <Text style={[styles.cameraStepTitle, { color: Colors[theme].text }]}>{t('docScan')}</Text>
        <Text style={[styles.cameraStepSubtitle, { color: Colors[theme].subtleText }]}>
          {t('docScanSubtitle')}
        </Text>
      </View>
      <View style={[styles.controlPanel, { backgroundColor: Colors[theme].cardBackground }]}>
        <TouchableOpacity
          style={[styles.scanBtn, { backgroundColor: Colors[theme].tint }]}
          onPress={async () => { await checkAndShowAd(); setStep('camera'); }}
          activeOpacity={0.7}
        >
          <FontAwesome name="camera" size={18} color="#fff" style={{ marginRight: 8 }} />
          <Text style={styles.scanBtnText}>{t('scanDoc')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.scanBtn, { backgroundColor: Colors[theme].inputBackground, marginTop: 10 }]}
          onPress={handlePickLibrary}
          activeOpacity={0.7}
        >
          <FontAwesome name="image" size={18} color={Colors[theme].text} style={{ marginRight: 8 }} />
          <Text style={[styles.scanBtnText, { color: Colors[theme].text }]}>{t('pickFromAlbum')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.langBtn, { backgroundColor: Colors[theme].inputBackground, marginTop: 10 }]}
          onPress={() => setLangModalVisible(true)}
          activeOpacity={0.7}
        >
          <FontAwesome name="globe" size={18} color={Colors[theme].subtleText} style={{ marginRight: 8 }} />
          <Text style={[styles.langBtnText, { color: Colors[theme].subtleText }]}>{t('language')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  // ── Camera step (live scanner) ──
  const renderCameraStep = () => (
    <CameraScanner
      processorRef={processorRef}
      onCapture={handleCameraCapture}
      onPickLibrary={handlePickLibrary}
    />
  );

  // ── Crop step ──
  const renderCropStep = () => (
    <View style={styles.flex}>
      <View style={styles.cropImageArea}>
        {imageUri && nativeScan ? (
          <Image
            source={{ uri: imageUri }}
            style={styles.nativeScanPreview}
            resizeMode="contain"
          />
        ) : imageUri ? (
          <CornerSelector
            imageUri={imageUri}
            imageWidth={imageSize.width}
            imageHeight={imageSize.height}
            corners={corners}
            onCornersChange={setCorners}
          />
        ) : null}
        {detecting && (
          <View style={styles.detectingOverlay}>
            <ActivityIndicator color="#fff" size="small" />
            <Text style={styles.detectingText}>{t('detecting')}</Text>
          </View>
        )}
      </View>

      <View style={[styles.controlPanel, { backgroundColor: Colors[theme].cardBackground }]}>
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: Colors[theme].inputBackground }]}
            onPress={resetToStart}
            activeOpacity={0.7}
          >
            <Text style={[styles.actionBtnText, { color: Colors[theme].text }]}>{t('retake')}</Text>
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
              <Text style={[styles.actionBtnText, { color: '#fff' }]}>{t('startProcess')}</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );

  // ── Preview step ──
  const renderPreviewStep = () => (
    <View style={styles.flex}>
      {result && (
        <ImageEditorPanel
          result={result}
          onResultChange={handleEditorResult}
          onRescan={resetToStart}
          onBackToCrop={() => setStep('crop')}
          onSavePng={savePng}
          onSavePdf={savePdf}
        />
      )}
    </View>
  );

  return (
    <View style={[styles.screen, { backgroundColor: Colors[theme].background }]}>
      <ImageProcessor ref={processorRef} />

      {processing && (
        <View style={styles.processingOverlay}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.processingText}>{t('processing')}</Text>
        </View>
      )}

      {step === 'home' && renderHomeStep()}
      {step === 'camera' && renderCameraStep()}
      {step === 'crop' && renderCropStep()}
      {step === 'preview' && renderPreviewStep()}

      {renderLanguageModal()}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
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
  processingOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  processingText: { color: '#fff', fontSize: 16, marginTop: 12 },
  detectingOverlay: {
    position: 'absolute',
    bottom: 12,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  detectingText: { color: '#fff', fontSize: 14 },
  cameraStep: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  cameraStepContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  cameraStepTitle: {
    fontSize: 24,
    fontWeight: '700',
  },
  cameraStepSubtitle: {
    fontSize: 15,
    textAlign: 'center',
  },
  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 12,
  },
  scanBtnText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  nativeScanPreview: {
    flex: 1,
    width: '100%',
    backgroundColor: '#000',
  },
  langBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 12,
  },
  langBtnText: {
    fontSize: 14,
    fontWeight: '500',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: 280,
    borderRadius: 16,
    paddingVertical: 16,
    maxHeight: 420,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
  },
  langItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  langFlag: {
    fontSize: 22,
    marginRight: 12,
  },
  langLabel: {
    fontSize: 16,
    flex: 1,
  },
});
