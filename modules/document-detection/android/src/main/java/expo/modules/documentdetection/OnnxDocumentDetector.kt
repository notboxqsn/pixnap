package expo.modules.documentdetection

import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import ai.onnxruntime.*
import java.nio.FloatBuffer
import kotlin.math.*

/**
 * Document corner detection using DocAligner ONNX heatmap model (fastvit_t8).
 * Input: (1, 3, 256, 256) float32 image, /255 normalized
 * Output: heatmap (1, 4, H, W) — 4 probability maps, one per corner
 * Postprocessing: weighted centroid of activations above threshold per channel
 */
object OnnxDocumentDetector {
  private const val TAG = "DocumentDetection"
  private const val MODEL_FILE = "docaligner_fastvit_t8.onnx"
  private const val INPUT_SIZE = 256
  private const val HEATMAP_THRESHOLD = 0.1f
  private const val MIN_ACTIVATION_PIXELS = 3

  private var ortEnv: OrtEnvironment? = null
  private var session: OrtSession? = null

  @Synchronized
  fun ensureInitialized(context: Context): Boolean {
    if (session != null) return true
    return try {
      val modelBytes = context.assets.open(MODEL_FILE).use { it.readBytes() }
      ortEnv = OrtEnvironment.getEnvironment()
      val opts = OrtSession.SessionOptions()
      session = ortEnv!!.createSession(modelBytes, opts)
      Log.d(TAG, "ONNX model loaded: $MODEL_FILE (${modelBytes.size / 1024}KB)")
      true
    } catch (e: Exception) {
      Log.e(TAG, "Failed to load ONNX model: ${e.message}", e)
      false
    }
  }

  /**
   * Detect document corners in a bitmap.
   * @return Corners with normalized (0-1) coordinates, or null if no document found.
   */
  fun detect(bitmap: Bitmap): Corners? {
    val sess = session ?: return null
    val env = ortEnv ?: return null

    val startTime = System.currentTimeMillis()

    // 1. Resize to 256×256 with bilinear filtering
    val scaled = Bitmap.createScaledBitmap(bitmap, INPUT_SIZE, INPUT_SIZE, true)
    val pixels = IntArray(INPUT_SIZE * INPUT_SIZE)
    scaled.getPixels(pixels, 0, INPUT_SIZE, 0, 0, INPUT_SIZE, INPUT_SIZE)
    if (scaled !== bitmap) scaled.recycle()

    // 2. Convert to float tensor: (1, 3, 256, 256), /255 normalized, CHW format
    val floatData = FloatArray(3 * INPUT_SIZE * INPUT_SIZE)
    val channelSize = INPUT_SIZE * INPUT_SIZE
    for (i in pixels.indices) {
      val px = pixels[i]
      floatData[i] = ((px shr 16) and 0xFF) / 255f               // R → channel 0
      floatData[channelSize + i] = ((px shr 8) and 0xFF) / 255f   // G → channel 1
      floatData[2 * channelSize + i] = (px and 0xFF) / 255f        // B → channel 2
    }

    val inputTensor = OnnxTensor.createTensor(
      env,
      FloatBuffer.wrap(floatData),
      longArrayOf(1, 3, INPUT_SIZE.toLong(), INPUT_SIZE.toLong())
    )

    // 3. Run inference
    val results = sess.run(mapOf("img" to inputTensor))
    inputTensor.close()

    // 4. Parse heatmap output
    val heatmapTensor = results.get("heatmap").orElse(null) as? OnnxTensor
    if (heatmapTensor == null) {
      Log.e(TAG, "ONNX: missing heatmap output")
      results.close()
      return null
    }

    val shape = heatmapTensor.info.shape  // [1, 4, H, W]
    val numCorners = shape[1].toInt()
    val heatH = shape[2].toInt()
    val heatW = shape[3].toInt()

    val heatmapData = FloatArray((shape[0] * shape[1] * shape[2] * shape[3]).toInt())
    heatmapTensor.floatBuffer.get(heatmapData)
    heatmapTensor.close()
    results.close()

    val elapsed = System.currentTimeMillis() - startTime
    Log.d(TAG, "ONNX inference: ${elapsed}ms, heatmap=${heatW}x${heatH}")

    // 5. Extract corner centroids from heatmaps using weighted center-of-mass
    val corners = mutableListOf<DoubleArray>()
    for (ci in 0 until minOf(numCorners, 4)) {
      val offset = ci * heatH * heatW
      var sumX = 0.0; var sumY = 0.0; var totalWeight = 0.0
      var activePx = 0

      for (y in 0 until heatH) {
        for (x in 0 until heatW) {
          val v = heatmapData[offset + y * heatW + x]
          if (v > HEATMAP_THRESHOLD) {
            val w = v.toDouble()
            sumX += x * w
            sumY += y * w
            totalWeight += w
            activePx++
          }
        }
      }

      if (activePx < MIN_ACTIVATION_PIXELS || totalWeight < 1e-6) {
        Log.d(TAG, "ONNX: corner $ci has too few activations ($activePx px)")
        return null
      }

      // Normalize centroid to [0, 1]
      val cx = (sumX / totalWeight) / (heatW - 1)
      val cy = (sumY / totalWeight) / (heatH - 1)
      corners.add(doubleArrayOf(cx, cy))
    }

    if (corners.size < 4) {
      Log.d(TAG, "ONNX: only found ${corners.size}/4 corners")
      return null
    }

    // 6. Heatmap channels are already ordered: 0=tl, 1=tr, 2=br, 3=bl
    // 7. Clamp to [0, 1] and return
    return Corners(
      tl = Point(corners[0][0].coerceIn(0.0, 1.0), corners[0][1].coerceIn(0.0, 1.0)),
      tr = Point(corners[1][0].coerceIn(0.0, 1.0), corners[1][1].coerceIn(0.0, 1.0)),
      br = Point(corners[2][0].coerceIn(0.0, 1.0), corners[2][1].coerceIn(0.0, 1.0)),
      bl = Point(corners[3][0].coerceIn(0.0, 1.0), corners[3][1].coerceIn(0.0, 1.0))
    ).also {
      Log.d(TAG, "ONNX result: tl=(%.3f,%.3f) tr=(%.3f,%.3f) br=(%.3f,%.3f) bl=(%.3f,%.3f)".format(
        it.tl.x, it.tl.y, it.tr.x, it.tr.y, it.br.x, it.br.y, it.bl.x, it.bl.y))
    }
  }

}
