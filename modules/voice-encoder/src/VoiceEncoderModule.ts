import { NativeModule, requireOptionalNativeModule } from 'expo';

declare class VoiceEncoderModule extends NativeModule<Record<string, never>> {
  /** Containers this platform can write: 'mpeg4' (.m4a/.mp4) and, on Android, 'adts' (.aac). */
  containers: string[];
  /** Encodes a 16-bit PCM WAV to AAC-LC. Resolves with the output size in bytes. */
  encodeAac(inputUri: string, outputUri: string, container: 'mpeg4' | 'adts', bitrate: number): Promise<number>;
}

/** null when the native module is not in the build (e.g. Expo Go or web). */
export default requireOptionalNativeModule<VoiceEncoderModule>('VoiceEncoder');
