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

    Events("onDecodeProgress")

    // Streams an audio file to mono 16-bit PCM at `sampleRate` (AVAudioFile + AVAudioConverter).
    AsyncFunction("decodeToPcm") { (id: String, inputUri: String, outputUri: String, sampleRate: Int) throws -> [String: Any] in
      Self.cancelLock.lock(); Self.cancelled.remove(id); Self.cancelLock.unlock()
      defer { Self.cancelLock.lock(); Self.cancelled.remove(id); Self.cancelLock.unlock() }
      return try Self.decode(id: id, from: Self.url(inputUri), to: Self.url(outputUri), rate: Double(sampleRate)) { p in
        self.sendEvent("onDecodeProgress", ["id": id, "fraction": p])
      }
    }

    Function("cancelDecode") { (id: String) in
      Self.cancelLock.lock(); Self.cancelled.insert(id); Self.cancelLock.unlock()
    }
  }

  private static var cancelled = Set<String>()
  private static let cancelLock = NSLock()

  private static func isCancelled(_ id: String) -> Bool {
    cancelLock.lock(); defer { cancelLock.unlock() }
    return cancelled.contains(id)
  }

  private static func decode(id: String, from inURL: URL, to outURL: URL, rate: Double, progress: (Double) -> Void) throws -> [String: Any] {
    let scoped = inURL.startAccessingSecurityScopedResource()
    defer { if scoped { inURL.stopAccessingSecurityScopedResource() } }
    let src = try AVAudioFile(forReading: inURL)
    let inFmt = src.processingFormat
    guard let outFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false),
          let converter = AVAudioConverter(from: inFmt, to: outFmt) else {
      throw Exception(name: "DecodeError", description: "Cannot convert this audio format")
    }
    converter.sampleRateConverterQuality = AVAudioQuality.high.rawValue
    // mix the channels down to mono (rather than keeping only the first one)
    if inFmt.channelCount > 1 { converter.downmix = true }
    try? FileManager.default.removeItem(at: outURL)
    FileManager.default.createFile(atPath: outURL.path, contents: nil)
    let handle = try FileHandle(forWritingTo: outURL)
    defer { try? handle.close() }
    let inCap: AVAudioFrameCount = 32768
    guard let inBuf = AVAudioPCMBuffer(pcmFormat: inFmt, frameCapacity: inCap),
          let outBuf = AVAudioPCMBuffer(pcmFormat: outFmt, frameCapacity: AVAudioFrameCount(Double(inCap) * rate / inFmt.sampleRate) + 1024) else {
      throw Exception(name: "BufferError", description: "Could not allocate audio buffers")
    }
    var frames: Int64 = 0
    var ended = false
    var lastP = -1.0
    while true {
      if isCancelled(id) { throw Exception(name: "CancelledError", description: "cancelled") }
      outBuf.frameLength = 0
      var readError: Error?
      let status = converter.convert(to: outBuf, error: nil) { _, inStatus in
        if ended { inStatus.pointee = .endOfStream; return nil }
        do {
          try src.read(into: inBuf, frameCount: inCap)
        } catch {
          readError = error
          inStatus.pointee = .endOfStream
          return nil
        }
        if inBuf.frameLength == 0 { ended = true; inStatus.pointee = .endOfStream; return nil }
        inStatus.pointee = .haveData
        return inBuf
      }
      if let e = readError { throw e }
      let n = Int(outBuf.frameLength)
      if n > 0, let ch = outBuf.floatChannelData?[0] {
        var data = Data(count: n * 2)
        data.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) in
          let p = raw.bindMemory(to: Int16.self)
          for i in 0..<n {
            let v = max(-1, min(1, ch[i])) * 32767
            p[i] = Int16(v.rounded()).littleEndian
          }
        }
        handle.write(data)
        frames += Int64(n)
      }
      if src.length > 0 {
        let p = Double(src.framePosition) / Double(src.length)
        if p - lastP >= 0.01 { lastP = p; progress(min(1, p)) }
      }
      if status == .endOfStream || status == .error || (n == 0 && ended) { break }
    }
    progress(1)
    return ["frames": Double(frames), "sourceRate": Int(inFmt.sampleRate), "sourceChannels": Int(inFmt.channelCount)]
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
