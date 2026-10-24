package expo.modules.voiceencoder

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Encodes a 16-bit PCM WAV file (as written by the app) to AAC-LC with the platform encoder,
 * either in an MPEG-4 container (.m4a / .mp4) or as raw ADTS (.aac).
 */
class VoiceEncoderModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("VoiceEncoder")

    Constant("containers") { listOf("mpeg4", "adts") }

    AsyncFunction("encodeAac") { inputUri: String, outputUri: String, container: String, bitrate: Int ->
      encode(toPath(inputUri), toPath(outputUri), container, bitrate)
      File(toPath(outputUri)).length().toDouble()
    }

    Events("onDecodeProgress")

    // Streams any readable audio file (file:// or content://) to mono 16-bit PCM at `sampleRate`.
    AsyncFunction("decodeToPcm") { id: String, inputUri: String, outputUri: String, sampleRate: Int ->
      val ctx = appContext.reactContext ?: throw IllegalStateException("No React context")
      cancelled.remove(id)
      try {
        val r = PcmDecoder(ctx).decode(inputUri, toPath(outputUri), sampleRate, { cancelled.contains(id) }) { p ->
          sendEvent("onDecodeProgress", mapOf("id" to id, "fraction" to p))
        }
        mapOf("frames" to r.frames.toDouble(), "sourceRate" to r.sourceRate, "sourceChannels" to r.sourceChannels)
      } finally {
        cancelled.remove(id)
      }
    }

    Function("cancelDecode") { id: String -> cancelled.add(id) }
  }

  private val cancelled = java.util.Collections.synchronizedSet(mutableSetOf<String>())

  private fun toPath(uri: String): String =
    if (uri.startsWith("file://")) java.net.URLDecoder.decode(uri.removePrefix("file://"), "UTF-8") else uri

  private class Wav(val sampleRate: Int, val channels: Int, val dataOffset: Long, val dataSize: Long)

  private fun readWav(raf: RandomAccessFile): Wav {
    val head = ByteArray(12)
    raf.readFully(head)
    if (String(head, 0, 4) != "RIFF" || String(head, 8, 4) != "WAVE") throw IllegalArgumentException("Not a WAV file")
    var rate = 0
    var channels = 0
    var bits = 0
    var format = 0
    while (raf.filePointer + 8 <= raf.length()) {
      val ch = ByteArray(8)
      raf.readFully(ch)
      val id = String(ch, 0, 4)
      val size = ByteBuffer.wrap(ch, 4, 4).order(ByteOrder.LITTLE_ENDIAN).int.toLong() and 0xffffffffL
      if (id == "fmt ") {
        val f = ByteArray(16)
        raf.readFully(f)
        val b = ByteBuffer.wrap(f).order(ByteOrder.LITTLE_ENDIAN)
        format = b.getShort(0).toInt()
        channels = b.getShort(2).toInt()
        rate = b.getInt(4)
        bits = b.getShort(14).toInt()
        raf.seek(raf.filePointer + size - 16 + (size % 2))
      } else if (id == "data") {
        if (format != 1 || bits != 16) throw IllegalArgumentException("Only 16-bit PCM WAV is supported")
        return Wav(rate, channels, raf.filePointer, minOf(size, raf.length() - raf.filePointer))
      } else {
        raf.seek(raf.filePointer + size + (size % 2))
      }
    }
    throw IllegalArgumentException("WAV file has no data chunk")
  }

  private fun adtsHeader(frameLen: Int, sampleRate: Int, channels: Int): ByteArray {
    val rates = intArrayOf(96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350)
    val freqIdx = rates.indexOf(sampleRate).let { if (it < 0) 4 else it }
    val profile = 2 // AAC LC
    val full = frameLen + 7
    return byteArrayOf(
      0xFF.toByte(),
      0xF1.toByte(), // MPEG-4, layer 0, no CRC
      (((profile - 1) shl 6) or (freqIdx shl 2) or (channels shr 2)).toByte(),
      (((channels and 3) shl 6) or (full shr 11)).toByte(),
      ((full and 0x7FF) shr 3).toByte(),
      (((full and 7) shl 5) or 0x1F).toByte(),
      0xFC.toByte()
    )
  }

  private fun encode(input: String, output: String, container: String, bitrate: Int) {
    val raf = RandomAccessFile(input, "r")
    val wav = readWav(raf)
    raf.seek(wav.dataOffset)
    val out = File(output)
    if (out.exists()) out.delete()

    val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, wav.sampleRate, wav.channels)
    format.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
    format.setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
    format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384)
    val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
    codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    codec.start()

    val muxer = if (container == "mpeg4") MediaMuxer(output, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4) else null
    val adts = if (container == "adts") FileOutputStream(out) else null
    var track = -1
    val bytesPerFrame = 2 * wav.channels
    var remaining = wav.dataSize
    var framesQueued = 0L
    var inputDone = false
    val info = MediaCodec.BufferInfo()
    val chunk = ByteArray(8192)
    try {
      while (true) {
        // queue input without waiting; wait briefly for output only when no input could be queued
        var fed = false
        if (!inputDone) {
          val inIdx = codec.dequeueInputBuffer(0)
          if (inIdx >= 0) {
            fed = true
            val buf = codec.getInputBuffer(inIdx)!!
            buf.clear()
            val cap = (minOf(buf.capacity(), chunk.size) / bytesPerFrame) * bytesPerFrame
            val n = minOf(cap.toLong(), remaining).toInt()
            val ptsUs = framesQueued * 1_000_000L / wav.sampleRate
            if (n <= 0) {
              codec.queueInputBuffer(inIdx, 0, 0, ptsUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              raf.readFully(chunk, 0, n)
              buf.put(chunk, 0, n)
              codec.queueInputBuffer(inIdx, 0, n, ptsUs, 0)
              remaining -= n
              framesQueued += n / bytesPerFrame
            }
          }
        }
        val outIdx = codec.dequeueOutputBuffer(info, if (fed) 0L else 2_000L)
        if (outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          if (muxer != null) {
            track = muxer.addTrack(codec.outputFormat)
            muxer.start()
          }
        } else if (outIdx >= 0) {
          val buf = codec.getOutputBuffer(outIdx)!!
          val isConfig = (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
          if (!isConfig && info.size > 0) {
            buf.position(info.offset)
            buf.limit(info.offset + info.size)
            if (muxer != null) {
              muxer.writeSampleData(track, buf, info)
            } else if (adts != null) {
              val data = ByteArray(info.size)
              buf.get(data)
              adts.write(adtsHeader(info.size, wav.sampleRate, wav.channels))
              adts.write(data)
            }
          }
          codec.releaseOutputBuffer(outIdx, false)
          if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break
        }
      }
    } finally {
      try { codec.stop() } catch (_: Exception) {}
      codec.release()
      try { if (track >= 0) muxer?.stop() } catch (_: Exception) {}
      muxer?.release()
      adts?.close()
      raf.close()
    }
  }
}
