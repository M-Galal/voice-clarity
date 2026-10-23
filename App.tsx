import { useEffect } from 'react';
import { ActivityIndicator, Alert, BackHandler, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { setAudioModeAsync } from 'expo-audio';
import { AppProvider, useApp } from './src/state/AppContext';
import { LibraryScreen } from './src/screens/LibraryScreen';
import { PlayerScreen } from './src/screens/PlayerScreen';
import { EnhanceScreen } from './src/screens/EnhanceScreen';
import { TranscriptScreen } from './src/screens/TranscriptScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';

function Router() {
  const { ready, route, goBack, colors, settings, updateSettings, t } = useApp();

  useEffect(() => {
    // Voice playback: audible in silent mode, keeps playing with the screen locked,
    // pauses other apps' audio. Phone calls and other interruptions pause us (system default).
    setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' }).catch(() => {});
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (route.name === 'library') return false;
      goBack();
      return true;
    });
    return () => sub.remove();
  }, [route, goBack]);

  useEffect(() => {
    if (ready && !settings.privacyAcknowledged) {
      Alert.alert(t('first_run_title'), t('privacy_text'), [{ text: t('ok'), onPress: () => updateSettings({ privacyAcknowledged: true }) }]);
    }
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }
  const dark = colors.bg !== '#F6F7F9';
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top', 'bottom', 'left', 'right']}>
      <StatusBar style={dark ? 'light' : 'dark'} />
      {route.name === 'library' && <LibraryScreen />}
      {route.name === 'player' && <PlayerScreen id={route.id} />}
      {route.name === 'enhance' && <EnhanceScreen id={route.id} auto={route.auto} />}
      {route.name === 'transcript' && <TranscriptScreen id={route.id} />}
      {route.name === 'settings' && <SettingsScreen />}
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <Router />
      </AppProvider>
    </SafeAreaProvider>
  );
}
