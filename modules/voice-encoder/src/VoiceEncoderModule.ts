import { NativeModule, requireOptionalNativeModule } from 'expo';

type Events = {
  onDecodeProgress: (e: { id: string; fraction: number }) => void;
};

declare class VoiceEncoderModule extends NativeModule<Events> {
  /** Containers this platform can write: 'mpeg4' (.m4a/.mp4) and, on Android, 'adts' (.aac). */
  containers: string[];
  /** Encodes a 16-bit PCM WAV to AAC-LC. Resolves with the output size in bytes. */
  encodeAac(inputUri: string, outputUri: string, container: 'mpeg4' | 'adts', bitrate: number): Promise<number>;
  /**
   * Streams an audio file (file:// or, on Android, content://) to raw mono 16-bit little-endian
   * PCM at `sampleRate`, without loading it into memory. Progress arrives as onDecodeProgress.
   */
  decodeToPcm(id: string, inputUri: string, outputUri: string, sampleRate: number): Promise<{ frames: number; sourceRate: number; sourceChannels: number }>;
  cancelDecode(id: string): void;
}

/** null when the native module is not in the build (e.g. Expo Go or web). */
export default requireOptionalNativeModule<VoiceEncoderModule>('VoiceEncoder');
