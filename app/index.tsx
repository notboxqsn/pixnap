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
  Modal,
  FlatList,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { File, Paths, Directory } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import DocumentScanner, { ResponseType, ScanDocumentResponseStatus } from 'react-native-document-scanner-plugin';
import { useTranslation } from 'react-i18next';
import Colors from '@/constants/Colors';
import CornerSelector from '@/components/scanner/CornerSelector';
import ImageProcessor, { ImageProcessorHandle } from '@/components/scanner/ImageProcessor';
import { generatePdf } from '@/services/pdfService';
import { checkAndShowAd } from '@/services/adService';
import { detectDocument } from '@/modules/document-detection/src';
import { SUPPORTED_LANGUAGES, changeLanguage } from '@/i18n';
import type { ScannerCorners, EnhanceMode, ScanResult } from '@/types';

type Step = 'camera' | 'crop' | 'preview';

const ENHANCE_OPTIONS: { key: EnhanceMode; labelKey: string; icon: string }[] = [
  { key: 'bw', labelKey: 'bw', icon: 'file-text-o' },
  { key: 'gray', labelKey: 'gray', icon: 'adjust' },
  { key: 'color', labelKey: 'color', icon: 'photo' },
];

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

  const [step, setStep] = useState<Step>('camera');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState({ width: 1, height: 1 });
  const [corners, setCorners] = useState<ScannerCorners>(DEFAULT_CORNERS);
  const [enhanceMode, setEnhanceMode] = useState<EnhanceMode>('color');
  const [processing, setProcessing] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [nativeScan, setNativeScan] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [langModalVisible, setLangModalVisible] = useState(false);
  const base64Ref = useRef<string | null>(null);

  const handleNativeScan = useCallback(async () => {
    try {
      await checkAndShowAd();
      const result = await DocumentScanner.scanDocument({
        responseType: ResponseType.Base64,
        croppedImageQuality: 100,
      });
      if (result.status === ScanDocumentResponseStatus.Cancel || !result.scannedImages?.length) return;
      const b64 = result.scannedImages[0];
      base64Ref.current = b64;
      // Decode image to get dimensions
      await new Promise<void>((resolve) => {
        Image.getSize(`data:image/jpeg;base64,${b64}`, (w, h) => {
          setImageUri(`data:image/jpeg;base64,${b64}`);
          setImageSize({ width: w, height: h });
          resolve();
        }, () => {
          setImageUri(`data:image/jpeg;base64,${b64}`);
          setImageSize({ width: 1, height: 1 });
          resolve();
        });
      });
      setCorners(FULL_CORNERS);
      setResult(null);
      setNativeScan(true);
      setStep('crop');
    } catch (e: any) {
      Alert.alert(t('scanFailed'), e.message || t('scanFailedMsg'));
    }
  }, [t]);

  const handlePickLibrary = useCallback(async () => {
    try {
      await checkAndShowAd();
      const pickerResult = await ImagePicker.launchImageLibraryAsync({
        quality: 1,
        mediaTypes: ['images'],
      });
      if (pickerResult.canceled || !pickerResult.assets[0]) return;
      const asset = pickerResult.assets[0];
      setImageUri(asset.uri);
      setImageSize({ width: asset.width, height: asset.height });
      setCorners(DEFAULT_CORNERS);
      setResult(null);
      setNativeScan(false);
      setStep('crop');
      // Auto-detect document corners using Apple Vision framework
      setDetecting(true);
      try {
        const file = new File(asset.uri);
        const b64 = await file.base64();
        base64Ref.current = b64;
        let found = false;
        try {
          const nativeCorners = await detectDocument(b64);
          if (nativeCorners) {
            setCorners(nativeCorners);
            found = true;
          }
        } catch {}
        if (!found && processorRef.current) {
          const detected = await processorRef.current.detect(b64);
          if (detected) {
            setCorners(detected);
          }
        }
      } catch {
        // detection failed silently, keep default corners
      } finally {
        setDetecting(false);
      }
    } catch (e: any) {
      Alert.alert(t('error'), e.message || t('pickImageFailed'));
    }
  }, [t]);

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
      const scansDir = new Directory(Paths.document, 'scans');
      if (!scansDir.exists) {
        scansDir.create();
      }
      const outFile = new File(scansDir, `scan_${Date.now()}.png`);
      outFile.create();
      outFile.write(result.base64, { encoding: 'base64' });
      await Sharing.shareAsync(outFile.uri, { mimeType: 'image/png' });
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

  const resetToStart = useCallback(() => {
    setStep('camera');
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

  // ── Camera step ──
  const renderCameraStep = () => (
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
          onPress={handleNativeScan}
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
        <Text style={[styles.controlLabel, { color: Colors[theme].subtleText }]}>{t('enhanceMode')}</Text>
        <View style={styles.modeRow}>
          {ENHANCE_OPTIONS.map((opt) => {
            const selected = enhanceMode === opt.key;
            return (
              <TouchableOpacity
                key={opt.key}
                style={[
                  styles.modeBtn,
                  {
                    borderColor: selected ? Colors[theme].tint : Colors[theme].inputBackground,
                    backgroundColor: selected ? Colors[theme].tint + '15' : Colors[theme].inputBackground,
                  },
                ]}
                onPress={() => setEnhanceMode(opt.key)}
                activeOpacity={0.7}
              >
                <FontAwesome
                  name={opt.icon as any}
                  size={18}
                  color={selected ? Colors[theme].tint : Colors[theme].subtleText}
                />
                <Text
                  style={[
                    styles.modeBtnText,
                    { color: selected ? Colors[theme].tint : Colors[theme].text },
                  ]}
                >
                  {t(opt.labelKey)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

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
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.previewScrollContent}
        maximumZoomScale={3}
        minimumZoomScale={1}
      >
        {result && (
          <>
            <Text style={{ color: '#f00', fontSize: 13, marginBottom: 8, textAlign: 'center' }}>
              {t('captureInfo', { inW: imageSize.width, inH: imageSize.height, outW: result.width, outH: result.height })}
            </Text>
            <Image
              source={{ uri: `data:image/png;base64,${result.base64}` }}
              style={{
                width: '100%',
                aspectRatio: result.width / result.height,
              }}
              resizeMode="contain"
            />
          </>
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
            <Text style={[styles.actionBtnText, { color: Colors[theme].text }]}>{t('rescan')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: Colors[theme].inputBackground }]}
            onPress={() => setStep('crop')}
            activeOpacity={0.7}
          >
            <FontAwesome name="crop" size={14} color={Colors[theme].text} style={{ marginRight: 6 }} />
            <Text style={[styles.actionBtnText, { color: Colors[theme].text }]}>{t('backToCrop')}</Text>
          </TouchableOpacity>
        </View>
        <View style={[styles.actionRow, { marginTop: 10 }]}>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: Colors[theme].tint }]}
            onPress={savePng}
            activeOpacity={0.7}
          >
            <FontAwesome name="image" size={14} color="#fff" style={{ marginRight: 6 }} />
            <Text style={[styles.actionBtnText, { color: '#fff' }]}>{t('savePng')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: '#ff3b30' }]}
            onPress={savePdf}
            activeOpacity={0.7}
          >
            <FontAwesome name="file-pdf-o" size={14} color="#fff" style={{ marginRight: 6 }} />
            <Text style={[styles.actionBtnText, { color: '#fff' }]}>{t('savePdf')}</Text>
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
          <Text style={styles.processingText}>{t('processing')}</Text>
        </View>
      )}

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
    borderWidth: 1.5,
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
