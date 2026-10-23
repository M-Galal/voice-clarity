/**
 * react-native-audio-api expects local files as file:// URIs. In Android release builds a
 * string without that prefix is treated as an asset bundled in the APK, so a bare path
 * fails to decode there (debug builds hide this). Always hand it a file:// URI.
 */
export const fileUri = (uriOrPath: string): string =>
  uriOrPath.startsWith('file://') ? uriOrPath : uriOrPath.startsWith('/') ? `file://${uriOrPath}` : uriOrPath;
