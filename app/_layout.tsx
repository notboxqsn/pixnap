import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';
import Colors from '@/constants/Colors';

export default function RootLayout() {
  const colorScheme = useColorScheme() ?? 'light';

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
          options={{ title: 'MiniScan' }}
        />
      </Stack>
    </>
  );
}
