package expo.modules.documentdetection

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class DocumentDetectionModule : Module() {
  companion object {
    const val TAG = "DocumentDetection"
  }

  override fun definition() = ModuleDefinition {
    Name("DocumentDetection")

    AsyncFunction("detectDocument") { base64: String ->
      try {
        detectImpl(base64)
      } catch (e: Exception) {
        Log.e(TAG, "Detection failed: ${e.message}", e)
        null
      }
    }
  }

  private fun cornersToMap(c: Corners): Map<String, Map<String, Double>> {
    Log.d(TAG, "Result: tl=(%.3f,%.3f) tr=(%.3f,%.3f) br=(%.3f,%.3f) bl=(%.3f,%.3f)".format(
      c.tl.x, c.tl.y, c.tr.x, c.tr.y, c.br.x, c.br.y, c.bl.x, c.bl.y))
    return mapOf(
      "tl" to mapOf("x" to c.tl.x, "y" to c.tl.y),
      "tr" to mapOf("x" to c.tr.x, "y" to c.tr.y),
      "br" to mapOf("x" to c.br.x, "y" to c.br.y),
      "bl" to mapOf("x" to c.bl.x, "y" to c.bl.y)
    )
  }

  private fun detectImpl(base64: String): Map<String, Map<String, Double>>? {
    val bytes = Base64.decode(base64, Base64.DEFAULT)

    // 1. Get original dimensions without decoding
    val boundsOpts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, boundsOpts)
    val origW = boundsOpts.outWidth
    val origH = boundsOpts.outHeight
    Log.d(TAG, "Original: ${origW}x${origH}")

    // 2. Decode with inSampleSize to keep decoded bitmap manageable
    var sampleSize = 1
    while (maxOf(origW / sampleSize, origH / sampleSize) > 1600) sampleSize *= 2
    val decodeOpts = BitmapFactory.Options().apply { inSampleSize = sampleSize }
    val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, decodeOpts)
      ?: return null
    Log.d(TAG, "Decoded: ${decoded.width}x${decoded.height} (sample=$sampleSize)")

    // 3. Try ONNX model first (ML-based, most accurate)
    val context = appContext.reactContext
    if (context != null) {
      OnnxDocumentDetector.ensureInitialized(context)
      val onnxResult = OnnxDocumentDetector.detect(decoded)
      if (onnxResult != null) {
        decoded.recycle()
        return cornersToMap(onnxResult)
      }
      Log.d(TAG, "ONNX failed, falling back to traditional CV")
    }

    // 4. Fallback: traditional CV pipeline (RANSAC → segment → contour → Hough)
    var gray800: DoubleArray? = null
    var w800 = 0; var h800 = 0

    if (maxOf(origW, origH) > 800 && maxOf(decoded.width, decoded.height) > 500) {
      val g = extractScaledGray(decoded, 800)
      if (g != null) {
        gray800 = g.first; w800 = g.second; h800 = g.third
      }
    }

    val g500 = extractScaledGray(decoded, 500)
    val gray500: DoubleArray
    val w500: Int; val h500: Int
    if (g500 != null) {
      gray500 = g500.first; w500 = g500.second; h500 = g500.third
    } else {
      gray500 = bitmapToGray(decoded)
      w500 = decoded.width; h500 = decoded.height
    }

    decoded.recycle()

    val corners = DocumentDetector.detect(gray800, w800, h800, gray500, w500, h500)
    if (corners != null) return cornersToMap(corners)

    Log.d(TAG, "No document found")
    return null
  }

  private fun extractScaledGray(src: Bitmap, maxSide: Int): Triple<DoubleArray, Int, Int>? {
    val longer = maxOf(src.width, src.height)
    if (longer <= maxSide) return null
    val scale = maxSide.toFloat() / longer
    val newW = (src.width * scale).toInt().coerceAtLeast(1)
    val newH = (src.height * scale).toInt().coerceAtLeast(1)
    val scaled = Bitmap.createScaledBitmap(src, newW, newH, true)
    val gray = bitmapToGray(scaled)
    if (scaled !== src) scaled.recycle()
    return Triple(gray, newW, newH)
  }

  private fun bitmapToGray(bmp: Bitmap): DoubleArray {
    val w = bmp.width; val h = bmp.height
    val pixels = IntArray(w * h)
    bmp.getPixels(pixels, 0, w, 0, 0, w, h)
    val gray = DoubleArray(w * h)
    for (i in 0 until w * h) {
      val px = pixels[i]
      gray[i] = 0.299 * ((px shr 16) and 0xFF) + 0.587 * ((px shr 8) and 0xFF) + 0.114 * (px and 0xFF)
    }
    return gray
  }
}
