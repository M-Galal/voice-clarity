import AVFoundation
import ExpoModulesCore

/// Encodes a PCM WAV file to AAC in an MPEG-4 container (.m4a / .mp4) with AVAudioFile.
/// Raw ADTS (.aac) is not offered on iOS; the app saves those edits as .m4a instead.
public class VoiceEncoderModule: Module {
  public func definition() -> ModuleDefinition {
    Name("VoiceEncoder")

    Constant("containers") { ["mpeg4"] }

    AsyncFunction("encodeAac") { (inputUri: String, outputUri: String, container: String, bitrate: Int) throws -> Double in
      guard container == "mpeg4" else {
        throw Exception(name: "UnsupportedContainer", description: "Only mpeg4 is supported on iOS")
      }
      let inURL = Self.url(inputUri)
      let outURL = Self.url(outputUri)
      try? FileManager.default.removeItem(at: outURL)
      try Self.encode(from: inURL, to: outURL, bitrate: bitrate)
      let attrs = try FileManager.default.attributesOfItem(atPath: outURL.path)
      return (attrs[.size] as? NSNumber)?.doubleValue ?? 0
    }
  }

  private static func url(_ s: String) -> URL {
    if let u = URL(string: s), u.isFileURL { return u }
    return URL(fileURLWithPath: s)
  }

  /// Both files are closed when this function returns (AVAudioFile closes on deinit).
  private static func encode(from inURL: URL, to outURL: URL, bitrate: Int) throws {
    let src = try AVAudioFile(forReading: inURL)
    let fmt = src.processingFormat
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVSampleRateKey: fmt.sampleRate,
      AVNumberOfChannelsKey: fmt.channelCount,
      AVEncoderBitRateKey: bitrate,
    ]
    let dst = try AVAudioFile(forWriting: outURL, settings: settings, commonFormat: fmt.commonFormat, interleaved: fmt.isInterleaved)
    guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: 8192) else {
      throw Exception(name: "BufferError", description: "Could not allocate an audio buffer")
    }
    while src.framePosition < src.length {
      try src.read(into: buf)
      if buf.frameLength == 0 { break }
      try dst.write(from: buf)
    }
  }
}
