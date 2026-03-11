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

    // 3. ONNX model detection only (no CV fallback)
    val context = appContext.reactContext
    if (context == null) {
      Log.e(TAG, "React context is null, cannot initialize ONNX")
      decoded.recycle()
      return null
    }

    val initialized = OnnxDocumentDetector.ensureInitialized(context)
    if (!initialized) {
      Log.e(TAG, "ONNX model failed to initialize")
      decoded.recycle()
      return null
    }

    val onnxResult = OnnxDocumentDetector.detect(decoded)
    decoded.recycle()

    if (onnxResult != null) {
      return cornersToMap(onnxResult)
    }

    Log.d(TAG, "ONNX: no document found")
    return null
  }

}
