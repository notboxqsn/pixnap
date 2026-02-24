import { Platform } from 'react-native';
import {
  InterstitialAd,
  AdEventType,
  TestIds,
} from 'react-native-google-mobile-ads';
import AsyncStorage from '@react-native-async-storage/async-storage';

const TAG = '[AdService]';
const AD_UNIT_ID = __DEV__
  ? TestIds.INTERSTITIAL
  : Platform.select({
      ios: 'ca-app-pub-6262791337263815/2894638795',
      android: 'ca-app-pub-6262791337263815/6833883809',
    })!;
const STORAGE_KEY = 'pixnap_daily_scan_count';

let interstitial: InterstitialAd | null = null;
let adLoaded = false;

function loadAd() {
  adLoaded = false;
  console.log(TAG, 'Loading interstitial ad...');
  interstitial = InterstitialAd.createForAdRequest(AD_UNIT_ID);

  interstitial.addAdEventListener(AdEventType.LOADED, () => {
    adLoaded = true;
    console.log(TAG, 'Interstitial ad loaded successfully');
  });

  interstitial.addAdEventListener(AdEventType.ERROR, (error) => {
    adLoaded = false;
    console.log(TAG, 'Interstitial ad failed to load:', error);
  });

  interstitial.load();
}

export async function initAds() {
  console.log(TAG, 'Initializing ads...');

  // Request ATT permission on iOS
  if (Platform.OS === 'ios') {
    try {
      const { requestTrackingPermissionsAsync } = await import(
        'expo-tracking-transparency'
      );
      const result = await requestTrackingPermissionsAsync();
      console.log(TAG, 'ATT permission result:', result.status);
    } catch (e) {
      console.log(TAG, 'ATT request failed:', e);
    }
  }

  // Initialize Mobile Ads SDK
  try {
    const mobileAds = (await import('react-native-google-mobile-ads')).default;
    await mobileAds().initialize();
    console.log(TAG, 'Mobile Ads SDK initialized');
  } catch (e) {
    console.log(TAG, 'Mobile Ads SDK init failed:', e);
    return;
  }

  // Preload first interstitial
  loadAd();
}

interface DailyScanData {
  date: string;
  count: number;
}

function getTodayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

async function getDailyScanData(): Promise<DailyScanData> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data: DailyScanData = JSON.parse(raw);
      if (data.date === getTodayString()) {
        return data;
      }
    }
  } catch {
    // ignore parse errors
  }
  return { date: getTodayString(), count: 0 };
}

async function saveDailyScanData(data: DailyScanData): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/**
 * Check daily scan count and show interstitial ad if needed.
 * First scan of the day is free; subsequent scans require watching an ad.
 * Returns a promise that resolves when the ad is closed (or immediately if no ad needed).
 */
export async function checkAndShowAd(): Promise<void> {
  const data = await getDailyScanData();
  console.log(TAG, `Daily scan count: ${data.count}, date: ${data.date}`);

  if (data.count >= 1) {
    console.log(TAG, `Scan #${data.count + 1} — ad required. adLoaded=${adLoaded}`);
    // Need to show ad
    if (adLoaded && interstitial) {
      console.log(TAG, 'Showing interstitial ad...');
      await new Promise<void>((resolve) => {
        interstitial!.addAdEventListener(AdEventType.CLOSED, () => {
          console.log(TAG, 'Interstitial ad closed by user');
          resolve();
          // Preload next ad
          loadAd();
        });
        interstitial!.show();
      });
    } else {
      console.log(TAG, 'Ad not loaded, letting user through');
    }
  } else {
    console.log(TAG, 'First scan of the day — free, no ad');
  }

  // Increment count
  data.count += 1;
  console.log(TAG, `Saving scan count: ${data.count}`);
  await saveDailyScanData(data);
}
