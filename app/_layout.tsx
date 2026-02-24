import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme, View, ActivityIndicator } from 'react-native';
import { I18nextProvider, useTranslation } from 'react-i18next';
import i18n, { i18nReady } from '@/i18n';
import Colors from '@/constants/Colors';
import { initAds } from '@/services/adService';

function RootStack() {
  const colorScheme = useColorScheme() ?? 'light';
  const { t } = useTranslation();

  useEffect(() => {
    initAds();
  }, []);

  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: Colors[colorScheme].cardBackground },
          headerTintColor: Colors[colorScheme].text,
          contentStyle: { backgroundColor: Colors[colorScheme].background },
        }}
      >
        <Stack.Screen
          name="index"
          options={{ title: t('appTitle') }}
        />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    i18nReady.then(() => setReady(true));
  }, []);

  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0e1117' }}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
    );
  }

  return (
    <I18nextProvider i18n={i18n}>
      <RootStack />
    </I18nextProvider>
  );
}
