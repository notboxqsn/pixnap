package expo.modules.documentdetection

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Matrix
import android.graphics.Paint
import android.util.Base64
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream

class DocumentDetectionModule : Module() {
  companion object {
    const val TAG = "DocumentDetection"
  }

  override fun definition() = ModuleDefinition {
    Name("DocumentDetection")

    // Native perspective correction using Android Bitmap/Canvas
    AsyncFunction("processImageNative") { base64: String, corners: Map<String, Map<String, Double>>, mode: String ->
      try {
        processImageImpl(base64, corners, mode)
      } catch (e: Exception) {
        Log.e(TAG, "processImageNative failed: ${e.message}", e)
        throw e
      }
    }

    // Native image editing — rotation, brightness, contrast, saturation, warmth, sepia, grayscale
    AsyncFunction("applyEditsNative") { base64: String, rotation: Int, brightness: Double, contrast: Double, saturation: Double, warmth: Double, sepia: Double, grayscale: Double ->
      try {
        applyEditsImpl(base64, rotation, brightness, contrast, saturation, warmth, sepia, grayscale)
      } catch (e: Exception) {
        Log.e(TAG, "applyEditsNative failed: ${e.message}", e)
        throw e
      }
    }

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

  private fun decodeBitmap(base64: String): Bitmap {
    val bytes = Base64.decode(base64, Base64.DEFAULT)
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
      ?: throw Exception("Failed to decode image")
  }

  private fun encodeBitmap(bitmap: Bitmap, quality: Int = 92): Map<String, Any> {
    val stream = ByteArrayOutputStream()
    bitmap.compress(Bitmap.CompressFormat.JPEG, quality, stream)
    val b64 = Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
    val w = bitmap.width
    val h = bitmap.height
    bitmap.recycle()
    return mapOf("base64" to b64, "width" to w, "height" to h)
  }

  // ── Perspective correction using quad-to-rect mapping ──
  private fun processImageImpl(
    base64: String,
    corners: Map<String, Map<String, Double>>,
    mode: String
  ): Map<String, Any> {
    val src = decodeBitmap(base64)
    val sw = src.width.toFloat()
    val sh = src.height.toFloat()

    val tl = corners["tl"]!!; val tr = corners["tr"]!!
    val br = corners["br"]!!; val bl = corners["bl"]!!

    // Source quad points (in pixel coords)
    val srcPts = floatArrayOf(
      (tl["x"]!! * sw).toFloat(), (tl["y"]!! * sh).toFloat(),
      (tr["x"]!! * sw).toFloat(), (tr["y"]!! * sh).toFloat(),
      (br["x"]!! * sw).toFloat(), (br["y"]!! * sh).toFloat(),
      (bl["x"]!! * sw).toFloat(), (bl["y"]!! * sh).toFloat()
    )

    // Output dimensions from edge distances
    val dw = maxOf(
      dist(srcPts[0], srcPts[1], srcPts[2], srcPts[3]),
      dist(srcPts[6], srcPts[7], srcPts[4], srcPts[5])
    ).toInt().coerceAtLeast(100)
    val dh = maxOf(
      dist(srcPts[0], srcPts[1], srcPts[6], srcPts[7]),
      dist(srcPts[2], srcPts[3], srcPts[4], srcPts[5])
    ).toInt().coerceAtLeast(100)

    // Limit output size
    val maxDim = 4000
    val scale = if (maxOf(dw, dh) > maxDim) maxDim.toFloat() / maxOf(dw, dh) else 1f
    val outW = (dw * scale).toInt()
    val outH = (dh * scale).toInt()

    // Destination rect points
    val dstPts = floatArrayOf(
      0f, 0f, outW.toFloat(), 0f,
      outW.toFloat(), outH.toFloat(), 0f, outH.toFloat()
    )

    // Compute perspective transform
    val matrix = Matrix()
    matrix.setPolyToPoly(srcPts, 0, dstPts, 0, 4)

    val result = Bitmap.createBitmap(outW, outH, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(result)
    canvas.drawColor(Color.WHITE)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    canvas.concat(matrix)
    canvas.drawBitmap(src, 0f, 0f, paint)
    src.recycle()

    // Apply color enhancement based on mode
    if (mode != "color") {
      val enhanced = applyModeFilter(result, mode)
      result.recycle()
      return encodeBitmap(enhanced)
    }

    // Color mode: subtle contrast boost
    val enhanced = applyColorMatrix(result, contrastMatrix(1.1f, 0.02f, 1.05f))
    result.recycle()
    return encodeBitmap(enhanced)
  }

  // ── Image editing: rotation + color adjustments ──
  private fun applyEditsImpl(
    base64: String,
    rotation: Int,
    brightness: Double,
    contrast: Double,
    saturation: Double,
    warmth: Double,
    sepia: Double,
    grayscale: Double
  ): Map<String, Any> {
    var bmp = decodeBitmap(base64)

    // Rotation
    if (rotation != 0) {
      val matrix = Matrix()
      matrix.postRotate(rotation.toFloat())
      val rotated = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, matrix, true)
      bmp.recycle()
      bmp = rotated
    }

    // Build combined ColorMatrix for brightness/contrast/saturation
    val cm = ColorMatrix()

    // Brightness: scale RGB
    if (brightness != 0.0) {
      val b = (brightness / 100f).toFloat()
      val bm = ColorMatrix(floatArrayOf(
        1f, 0f, 0f, 0f, b * 255f,
        0f, 1f, 0f, 0f, b * 255f,
        0f, 0f, 1f, 0f, b * 255f,
        0f, 0f, 0f, 1f, 0f
      ))
      cm.postConcat(bm)
    }

    // Contrast
    if (contrast != 0.0) {
      val c = (1f + contrast / 100f).toFloat()
      val t = 128f * (1f - c)
      val ccm = ColorMatrix(floatArrayOf(
        c, 0f, 0f, 0f, t,
        0f, c, 0f, 0f, t,
        0f, 0f, c, 0f, t,
        0f, 0f, 0f, 1f, 0f
      ))
      cm.postConcat(ccm)
    }

    // Saturation
    if (saturation != 0.0) {
      val s = (1f + saturation / 100f).toFloat()
      val sm = ColorMatrix()
      sm.setSaturation(s)
      cm.postConcat(sm)
    }

    // Warmth (shift red up, blue down)
    if (warmth != 0.0) {
      val w = (warmth * 0.5f).toFloat()
      val wm = ColorMatrix(floatArrayOf(
        1f, 0f, 0f, 0f, w,
        0f, 1f, 0f, 0f, 0f,
        0f, 0f, 1f, 0f, -w,
        0f, 0f, 0f, 1f, 0f
      ))
      cm.postConcat(wm)
    }

    // Grayscale
    if (grayscale > 0) {
      val g = (grayscale / 100f).toFloat()
      val gm = ColorMatrix()
      gm.setSaturation(1f - g)
      cm.postConcat(gm)
    }

    // Sepia
    if (sepia > 0) {
      val s = (sepia / 100f).toFloat()
      val sepiaMatrix = ColorMatrix(floatArrayOf(
        1f - 0.607f * s, 0.769f * s, 0.189f * s, 0f, 0f,
        0.349f * s, 1f - 0.314f * s, 0.168f * s, 0f, 0f,
        0.272f * s, 0.534f * s, 1f - 0.869f * s, 0f, 0f,
        0f, 0f, 0f, 1f, 0f
      ))
      cm.postConcat(sepiaMatrix)
    }

    val edited = applyColorMatrix(bmp, cm)
    bmp.recycle()
    return encodeBitmap(edited)
  }

  // ── Helpers ──
  private fun dist(x1: Float, y1: Float, x2: Float, y2: Float): Float {
    val dx = x2 - x1; val dy = y2 - y1
    return kotlin.math.sqrt(dx * dx + dy * dy)
  }

  private fun applyColorMatrix(src: Bitmap, cm: ColorMatrix): Bitmap {
    val result = Bitmap.createBitmap(src.width, src.height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(result)
    val paint = Paint()
    paint.colorFilter = ColorMatrixColorFilter(cm)
    canvas.drawBitmap(src, 0f, 0f, paint)
    return result
  }

  private fun contrastMatrix(contrast: Float, brightness: Float, saturation: Float): ColorMatrix {
    val cm = ColorMatrix()
    val t = 128f * (1f - contrast)
    val ccm = ColorMatrix(floatArrayOf(
      contrast, 0f, 0f, 0f, t + brightness * 255f,
      0f, contrast, 0f, 0f, t + brightness * 255f,
      0f, 0f, contrast, 0f, t + brightness * 255f,
      0f, 0f, 0f, 1f, 0f
    ))
    cm.postConcat(ccm)
    val sm = ColorMatrix()
    sm.setSaturation(saturation)
    cm.postConcat(sm)
    return cm
  }

  private fun applyModeFilter(src: Bitmap, mode: String): Bitmap {
    return when (mode) {
      "gray" -> applyColorMatrix(src, contrastMatrix(1.3f, 0.05f, 0f))
      "bw" -> applyColorMatrix(src, contrastMatrix(2.0f, 0.1f, 0f))
      else -> src
    }
  }

}
