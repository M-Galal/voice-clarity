package expo.modules.voiceencoder

import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * Decodes any audio file the platform can read (MediaExtractor + MediaCodec) to mono 16-bit PCM
 * at a chosen sample rate, streaming: memory use does not grow with the file length. Channels are
 * averaged; the rate is changed with a windowed-sinc resampler.
 */
class PcmDecoder(private val context: Context) {
  class Result(val frames: Long, val sourceRate: Int, val sourceChannels: Int)

  fun decode(input: String, outputPath: String, outRate: Int, cancelled: () -> Boolean, progress: (Double) -> Unit): Result {
    val ex = MediaExtractor()
    if (input.startsWith("content://")) ex.setDataSource(context, Uri.parse(input), null)
    else ex.setDataSource(toPath(input))
    var track = -1
    for (i in 0 until ex.trackCount) {
      if (ex.getTrackFormat(i).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true) { track = i; break }
    }
    if (track < 0) { ex.release(); throw IllegalArgumentException("No audio track found") }
    ex.selectTrack(track)
    val fmt = ex.getTrackFormat(track)
    val durationUs = if (fmt.containsKey(MediaFormat.KEY_DURATION)) fmt.getLong(MediaFormat.KEY_DURATION) else 0L
    var inRate = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE)
    var channels = fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
    var floatPcm = false
    val codec = MediaCodec.createDecoderByType(fmt.getString(MediaFormat.KEY_MIME)!!)
    codec.configure(fmt, null, null, 0)
    codec.start()

    val outFile = File(outputPath)
    if (outFile.exists()) outFile.delete()
    val out = BufferedOutputStream(FileOutputStream(outFile), 1 shl 16)
    var resampler: Resampler? = null
    var frames = 0L
    val info = MediaCodec.BufferInfo()
    var inputDone = false
    var lastProgress = -1.0

    fun writeMono(mono: FloatArray, n: Int) {
      val rs = resampler ?: Resampler(inRate, outRate).also { resampler = it }
      val res = rs.process(mono, n)
      frames += writeShorts(out, res.first, res.second)
    }

    try {
      while (true) {
        if (cancelled()) throw InterruptedException("cancelled")
        // Feed input without waiting; only wait (briefly) for output when no input could be queued.
        // A 10 ms wait per buffer made AAC decoding wait ~10 ms for every 23 ms of audio.
        var fed = false
        if (!inputDone) {
          val inIdx = codec.dequeueInputBuffer(0)
          if (inIdx >= 0) {
            fed = true
            val buf = codec.getInputBuffer(inIdx)!!
            val n = ex.readSampleData(buf, 0)
            if (n < 0) {
              codec.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              codec.queueInputBuffer(inIdx, 0, n, ex.sampleTime, 0)
              if (durationUs > 0) {
                val p = ex.sampleTime.toDouble() / durationUs
                if (p - lastProgress >= 0.01) { lastProgress = p; progress(min(1.0, p)) }
              }
              ex.advance()
            }
          }
        }
        val outIdx = codec.dequeueOutputBuffer(info, if (fed) 0L else 2_000L)
        if (outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          val of = codec.outputFormat
          inRate = of.getInteger(MediaFormat.KEY_SAMPLE_RATE)
          channels = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
          floatPcm = of.containsKey(MediaFormat.KEY_PCM_ENCODING) && of.getInteger(MediaFormat.KEY_PCM_ENCODING) == AudioFormat.ENCODING_PCM_FLOAT
        } else if (outIdx >= 0) {
          val buf = codec.getOutputBuffer(outIdx)!!
          if (info.size > 0) {
            buf.position(info.offset)
            buf.limit(info.offset + info.size)
            val bb = buf.slice().order(ByteOrder.nativeOrder())
            val mono: FloatArray
            val n: Int
            if (floatPcm) {
              val fb = bb.asFloatBuffer()
              n = fb.remaining() / channels
              mono = FloatArray(n)
              for (i in 0 until n) { var s = 0f; for (c in 0 until channels) s += fb.get(i * channels + c); mono[i] = s / channels }
            } else {
              val sb = bb.asShortBuffer()
              n = sb.remaining() / channels
              mono = FloatArray(n)
              for (i in 0 until n) { var s = 0f; for (c in 0 until channels) s += sb.get(i * channels + c) / 32768f; mono[i] = s / channels }
            }
            writeMono(mono, n)
          }
          codec.releaseOutputBuffer(outIdx, false)
          if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break
        }
      }
      resampler?.let { val tail = it.flush(); frames += writeShorts(out, tail.first, tail.second) }
      progress(1.0)
    } finally {
      try { codec.stop() } catch (_: Exception) {}
      codec.release()
      ex.release()
      out.close()
    }
    return Result(frames, inRate, channels)
  }

  private fun writeShorts(out: BufferedOutputStream, x: FloatArray, n: Int): Long {
    if (n == 0) return 0
    val bytes = ByteBuffer.allocate(n * 2).order(ByteOrder.LITTLE_ENDIAN)
    for (i in 0 until n) {
      val v = (x[i] * 32767f).roundToInt().coerceIn(-32768, 32767)
      bytes.putShort(v.toShort())
    }
    out.write(bytes.array())
    return n.toLong()
  }

  private fun toPath(uri: String): String =
    if (uri.startsWith("file://")) java.net.URLDecoder.decode(uri.removePrefix("file://"), "UTF-8") else uri
}

/**
 * Streaming windowed-sinc (Blackman) resampler. Cut-off at 0.95 × the lower Nyquist frequency;
 * 16 zero crossings each side (scaled when downsampling). The kernel is tabulated.
 */
class Resampler(private val inRate: Int, private val outRate: Int) {
  private val same = inRate == outRate
  private val ratio = inRate.toDouble() / outRate // input samples per output sample
  private val fc = 0.95 * min(1.0, outRate.toDouble() / inRate) // cut-off, cycles per input sample × 2
  private val zeros = 16
  private val half = (zeros / fc).let { floor(it).toInt() + 1 } // input samples each side
  private val tableRes = 512
  private val table: FloatArray
  private var hist = FloatArray(0) // input samples from absolute index histStart
  private var histStart = -half.toLong() // leading zeros so the first output is centred on input 0
  private var nextOut = 0L // next output index
  private var inCount = 0L

  init {
    val n = half * tableRes + 1
    table = FloatArray(n + 1)
    for (i in 0..n) {
      val x = i.toDouble() / tableRes // distance in input samples
      val sx = x * fc
      val sinc = if (sx == 0.0) 1.0 else sin(PI * sx) / (PI * sx)
      val w = if (x >= half) 0.0 else (0.42 + 0.5 * cos(PI * x / half) + 0.08 * cos(2 * PI * x / half))
      table[i] = (fc * sinc * w).toFloat()
    }
    hist = FloatArray(half) // zeros
  }

  private fun kernel(d: Double): Float {
    val a = kotlin.math.abs(d) * tableRes
    val i = a.toInt()
    if (i >= table.size - 1) return 0f
    val f = (a - i).toFloat()
    return table[i] * (1 - f) + table[i + 1] * f
  }

  fun process(x: FloatArray, n: Int): Pair<FloatArray, Int> {
    if (same) return Pair(x, n)
    val buf = FloatArray(hist.size + n)
    System.arraycopy(hist, 0, buf, 0, hist.size)
    System.arraycopy(x, 0, buf, hist.size, n)
    inCount += n
    val availEnd = histStart + buf.size // absolute input index (exclusive)
    val out = ArrayList<Float>()
    val res = FloatArray(max(16, ((n / ratio) + 4).toInt()))
    var o = 0
    while (true) {
      val centre = nextOut * ratio
      val last = floor(centre).toLong() + half
      if (last >= availEnd) break
      val first = floor(centre).toLong() - half + 1
      var acc = 0f
      for (k in first..last) {
        val v = buf[(k - histStart).toInt()]
        if (v != 0f) acc += v * kernel(centre - k)
      }
      if (o >= res.size) { out.addAll(res.toList()); o = 0 }
      res[o++] = acc
      nextOut++
    }
    val keepFrom = floor(nextOut * ratio).toLong() - half + 1
    val drop = (keepFrom - histStart).toInt().coerceIn(0, buf.size)
    hist = buf.copyOfRange(drop, buf.size)
    histStart += drop
    if (out.isEmpty()) return Pair(res, o)
    val all = FloatArray(out.size + o)
    for (i in out.indices) all[i] = out[i]
    System.arraycopy(res, 0, all, out.size, o)
    return Pair(all, all.size)
  }

  /** Remaining output, with zeros after the last input sample. */
  fun flush(): Pair<FloatArray, Int> {
    if (same) return Pair(FloatArray(0), 0)
    val total = (inCount * outRate / inRate)
    val pad = FloatArray(half + 2)
    val (y, m) = process(pad, pad.size)
    val keep = (total - (nextOut - m)).toInt().coerceIn(0, m)
    return Pair(y, keep)
  }
}
