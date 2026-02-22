package expo.modules.documentdetection

import android.util.Log
import kotlin.math.*

data class Point(val x: Double, val y: Double)
data class Corners(val tl: Point, val tr: Point, val br: Point, val bl: Point)

private data class RansacResult(
  val a: Double, val b: Double, val c: Double,
  val count: Int, val score: Double,
  val inlierMask: BooleanArray,
  val cx: Double, val cy: Double
)
private data class HoughLine(val rho: Int, val theta: Double, val votes: Int)

object DocumentDetector {
  private const val TAG = "DocumentDetection"

  /**
   * Main entry: run detection pipeline on pre-computed gray arrays.
   * @param gray800 grayscale at ~800px long side (null if original < 800px)
   * @param gray500 grayscale at ~500px long side
   */
  fun detect(
    gray800: DoubleArray?, w800: Int, h800: Int,
    gray500: DoubleArray, w500: Int, h500: Int
  ): Corners? {
    // 1. Try RANSAC at 800px
    if (gray800 != null) {
      val result = gradientRansacDetection(gray800, w800, h800)
      if (result != null) {
        Log.d(TAG, "RANSAC@800 succeeded")
        return result
      }
    }

    // 2. Try RANSAC at 500px
    val ransac500 = gradientRansacDetection(gray500, w500, h500)
    if (ransac500 != null) {
      Log.d(TAG, "RANSAC@500 succeeded")
      return ransac500
    }

    // 3. Segment-based detection
    val seg = segmentBasedDetection(gray500, w500, h500)
    if (seg != null) {
      Log.d(TAG, "Segment succeeded")
      return seg
    }

    // 4. Edge-based: contour then Hough
    val edges = cannyEdges(gray500, w500, h500)
    val contour = contourBasedDetection(edges, w500, h500)
    if (contour != null) {
      Log.d(TAG, "Contour succeeded")
      return contour
    }

    val lines = houghLines(edges, w500, h500)
    val hough = findBestQuad(lines, w500, h500)
    if (hough != null) {
      Log.d(TAG, "Hough succeeded")
      return hough
    }

    Log.d(TAG, "All methods failed (${w500}x${h500})")
    return null
  }

  // ── Gaussian blur 5x5 ──

  private val GAUSS_KERNEL = intArrayOf(
    1, 4, 7, 4, 1,
    4, 16, 26, 16, 4,
    7, 26, 41, 26, 7,
    4, 16, 26, 16, 4,
    1, 4, 7, 4, 1
  )
  private const val GAUSS_SUM = 273

  private fun gaussianBlur5x5(gray: DoubleArray, w: Int, h: Int): DoubleArray {
    val out = DoubleArray(w * h)
    for (y in 0 until h) {
      for (x in 0 until w) {
        var sum = 0.0
        for (ky in -2..2) {
          for (kx in -2..2) {
            val py = (y + ky).coerceIn(0, h - 1)
            val px = (x + kx).coerceIn(0, w - 1)
            sum += gray[py * w + px] * GAUSS_KERNEL[(ky + 2) * 5 + (kx + 2)]
          }
        }
        out[y * w + x] = sum / GAUSS_SUM
      }
    }
    return out
  }

  // ── Sobel gradients ──

  private fun sobelGradients(gray: DoubleArray, w: Int, h: Int): Pair<DoubleArray, DoubleArray> {
    val mag = DoubleArray(w * h)
    val dir = DoubleArray(w * h)
    for (y in 1 until h - 1) {
      for (x in 1 until w - 1) {
        val gx = -gray[(y - 1) * w + (x - 1)] + gray[(y - 1) * w + (x + 1)] -
                 2 * gray[y * w + (x - 1)] + 2 * gray[y * w + (x + 1)] -
                 gray[(y + 1) * w + (x - 1)] + gray[(y + 1) * w + (x + 1)]
        val gy = -gray[(y - 1) * w + (x - 1)] - 2 * gray[(y - 1) * w + x] - gray[(y - 1) * w + (x + 1)] +
                 gray[(y + 1) * w + (x - 1)] + 2 * gray[(y + 1) * w + x] + gray[(y + 1) * w + (x + 1)]
        mag[y * w + x] = sqrt(gx * gx + gy * gy)
        dir[y * w + x] = atan2(gy, gx)
      }
    }
    return Pair(mag, dir)
  }

  // ── Non-maximum suppression ──

  private fun nonMaxSuppression(mag: DoubleArray, dir: DoubleArray, w: Int, h: Int): DoubleArray {
    val out = DoubleArray(w * h)
    for (y in 1 until h - 1) {
      for (x in 1 until w - 1) {
        var angle = dir[y * w + x] * 180.0 / PI
        if (angle < 0) angle += 180.0
        val m = mag[y * w + x]
        val n1: Double
        val n2: Double
        when {
          angle < 22.5 || angle >= 157.5 -> {
            n1 = mag[y * w + (x - 1)]
            n2 = mag[y * w + (x + 1)]
          }
          angle < 67.5 -> {
            n1 = mag[(y - 1) * w + (x + 1)]
            n2 = mag[(y + 1) * w + (x - 1)]
          }
          angle < 112.5 -> {
            n1 = mag[(y - 1) * w + x]
            n2 = mag[(y + 1) * w + x]
          }
          else -> {
            n1 = mag[(y - 1) * w + (x - 1)]
            n2 = mag[(y + 1) * w + (x + 1)]
          }
        }
        out[y * w + x] = if (m >= n1 && m >= n2) m else 0.0
      }
    }
    return out
  }

  // ── Canny edges ──

  private fun cannyEdges(gray: DoubleArray, w: Int, h: Int): IntArray {
    val blurred = gaussianBlur5x5(gray, w, h)
    val (mag, dir) = sobelGradients(blurred, w, h)
    val nms = nonMaxSuppression(mag, dir, w, h)

    var maxMag = 0.0
    for (i in 0 until w * h) {
      if (nms[i] > maxMag) maxMag = nms[i]
    }
    if (maxMag < 1.0) return IntArray(w * h)

    val histSize = 256
    val hist = DoubleArray(histSize)
    for (i in 0 until w * h) {
      val bin = (nms[i] / maxMag * 255).toInt().coerceIn(0, 255)
      hist[bin]++
    }
    val total = w * h
    var sumAll = 0.0
    for (i in 0 until histSize) sumAll += i * hist[i]

    var sumB = 0.0; var wB = 0.0; var bestThresh = 0; var bestVar = 0.0
    for (t in 0 until histSize) {
      wB += hist[t]
      if (wB == 0.0) continue
      val wF = total - wB
      if (wF == 0.0) break
      sumB += t * hist[t]
      val mB = sumB / wB
      val mF = (sumAll - sumB) / wF
      val between = wB * wF * (mB - mF) * (mB - mF)
      if (between > bestVar) { bestVar = between; bestThresh = t }
    }
    val highThresh = (bestThresh.toDouble() / 255) * maxMag
    val lowThresh = highThresh * 0.5

    val STRONG = 255; val WEAK = 128
    val edges = IntArray(w * h)
    for (i in 0 until w * h) {
      edges[i] = when {
        nms[i] >= highThresh -> STRONG
        nms[i] >= lowThresh -> WEAK
        else -> 0
      }
    }
    var changed = true
    while (changed) {
      changed = false
      for (y in 1 until h - 1) {
        for (x in 1 until w - 1) {
          if (edges[y * w + x] != WEAK) continue
          if (edges[(y - 1) * w + (x - 1)] == STRONG || edges[(y - 1) * w + x] == STRONG ||
            edges[(y - 1) * w + (x + 1)] == STRONG || edges[y * w + (x - 1)] == STRONG ||
            edges[y * w + (x + 1)] == STRONG || edges[(y + 1) * w + (x - 1)] == STRONG ||
            edges[(y + 1) * w + x] == STRONG || edges[(y + 1) * w + (x + 1)] == STRONG
          ) {
            edges[y * w + x] = STRONG
            changed = true
          }
        }
      }
    }
    for (i in 0 until w * h) {
      edges[i] = if (edges[i] == STRONG) 255 else 0
    }
    return edges
  }

  // ── Morphological operations ──

  private fun dilateEdgesR(edges: IntArray, w: Int, h: Int, radius: Int): IntArray {
    val out = IntArray(w * h)
    for (y in 0 until h) {
      for (x in 0 until w) {
        if (edges[y * w + x] != 255) continue
        for (dy in -radius..radius) {
          for (dx in -radius..radius) {
            val ny = y + dy; val nx = x + dx
            if (ny in 0 until h && nx in 0 until w) {
              out[ny * w + nx] = 255
            }
          }
        }
      }
    }
    return out
  }

  private fun erodeR(bin: IntArray, w: Int, h: Int, radius: Int): IntArray {
    val out = IntArray(w * h)
    for (y in 0 until h) {
      for (x in 0 until w) {
        if (bin[y * w + x] != 255) continue
        var all = true
        loop@ for (dy in -radius..radius) {
          for (dx in -radius..radius) {
            val ny = y + dy; val nx = x + dx
            if (ny < 0 || ny >= h || nx < 0 || nx >= w || bin[ny * w + nx] != 255) {
              all = false; break@loop
            }
          }
        }
        if (all) out[y * w + x] = 255
      }
    }
    return out
  }

  // ── Connected-component labeling ──

  private data class CompInfo(val label: Int, val size: Int)

  private fun labelComponents(bin: IntArray, w: Int, h: Int): Pair<IntArray, List<CompInfo>> {
    val labels = IntArray(w * h)
    val comps = mutableListOf<CompInfo>()
    var label = 0
    val dx8 = intArrayOf(1, 1, 0, -1, -1, -1, 0, 1)
    val dy8 = intArrayOf(0, 1, 1, 1, 0, -1, -1, -1)
    for (sy in 0 until h) {
      for (sx in 0 until w) {
        if (bin[sy * w + sx] == 0 || labels[sy * w + sx] != 0) continue
        label++
        val stack = ArrayDeque<Int>()
        stack.addLast(sy * w + sx)
        labels[sy * w + sx] = label
        var cnt = 0
        while (stack.isNotEmpty()) {
          val idx = stack.removeLast()
          cnt++
          val cx = idx % w; val cy = idx / w
          for (d in 0 until 8) {
            val nx = cx + dx8[d]; val ny = cy + dy8[d]
            if (nx in 0 until w && ny in 0 until h) {
              val nIdx = ny * w + nx
              if (bin[nIdx] == 255 && labels[nIdx] == 0) {
                labels[nIdx] = label
                stack.addLast(nIdx)
              }
            }
          }
        }
        comps.add(CompInfo(label, cnt))
      }
    }
    return Pair(labels, comps)
  }

  // ── Convex hull (Graham scan) ──

  private fun convexHull(points: List<DoubleArray>): List<DoubleArray> {
    if (points.size < 3) return points.toList()
    val sorted = points.sortedWith(compareBy({ it[0] }, { it[1] }))
    val unique = mutableListOf(sorted[0])
    for (i in 1 until sorted.size) {
      if (sorted[i][0] != sorted[i - 1][0] || sorted[i][1] != sorted[i - 1][1]) unique.add(sorted[i])
    }
    if (unique.size < 3) return unique

    fun cross(o: DoubleArray, a: DoubleArray, b: DoubleArray): Double =
      (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    val lower = mutableListOf<DoubleArray>()
    for (p in unique) {
      while (lower.size >= 2 && cross(lower[lower.size - 2], lower[lower.size - 1], p) <= 0) lower.removeAt(lower.size - 1)
      lower.add(p)
    }
    val upper = mutableListOf<DoubleArray>()
    for (i in unique.indices.reversed()) {
      val p = unique[i]
      while (upper.size >= 2 && cross(upper[upper.size - 2], upper[upper.size - 1], p) <= 0) upper.removeAt(upper.size - 1)
      upper.add(p)
    }
    lower.removeAt(lower.size - 1)
    upper.removeAt(upper.size - 1)
    return lower + upper
  }

  // ── Douglas-Peucker simplification ──

  private fun douglasPeucker(points: List<DoubleArray>, epsilon: Double): List<DoubleArray> {
    if (points.size <= 2) return points.toList()
    val keep = BooleanArray(points.size)
    keep[0] = true; keep[points.size - 1] = true
    val stack = ArrayDeque<Pair<Int, Int>>()
    stack.addLast(Pair(0, points.size - 1))
    while (stack.isNotEmpty()) {
      val (si, ei) = stack.removeLast()
      var maxDist = 0.0; var maxIdx = si
      val sx = points[si][0]; val sy = points[si][1]
      val ex = points[ei][0]; val ey = points[ei][1]
      val dx = ex - sx; val dy = ey - sy
      val lenSq = dx * dx + dy * dy
      for (i in si + 1 until ei) {
        val d = if (lenSq < 1e-10) {
          sqrt((points[i][0] - sx).let { it * it } + (points[i][1] - sy).let { it * it })
        } else {
          abs(dy * points[i][0] - dx * points[i][1] + ex * sy - ey * sx) / sqrt(lenSq)
        }
        if (d > maxDist) { maxDist = d; maxIdx = i }
      }
      if (maxDist > epsilon) {
        keep[maxIdx] = true
        stack.addLast(Pair(si, maxIdx))
        stack.addLast(Pair(maxIdx, ei))
      }
    }
    return points.filterIndexed { i, _ -> keep[i] }
  }

  // ── Contour area (Shoelace) ──

  private fun contourArea(pts: List<DoubleArray>): Double {
    var area = 0.0
    for (i in pts.indices) {
      val j = (i + 1) % pts.size
      area += pts[i][0] * pts[j][1]
      area -= pts[j][0] * pts[i][1]
    }
    return abs(area) / 2.0
  }

  // ── Convexity check ──

  private fun isConvex(pts: List<DoubleArray>): Boolean {
    val n = pts.size
    if (n < 3) return false
    var sign = 0
    for (i in 0 until n) {
      val a = pts[i]; val b = pts[(i + 1) % n]; val c = pts[(i + 2) % n]
      val cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
      if (abs(cross) < 1e-6) continue
      val s = if (cross > 0) 1 else -1
      if (sign == 0) sign = s
      else if (s != sign) return false
    }
    return sign != 0
  }

  // ── Order corners: sort by y → top/bottom pairs, then by x ──

  private fun orderCorners(pts: List<DoubleArray>): List<DoubleArray> {
    val sorted = pts.sortedBy { it[1] }
    val top = sorted.subList(0, 2).sortedBy { it[0] }
    val bot = sorted.subList(2, 4).sortedBy { it[0] }
    return listOf(top[0], top[1], bot[1], bot[0]) // tl, tr, br, bl
  }

  // ── Validate quadrilateral ──

  private fun validateQuad(pts: List<DoubleArray>, w: Int, h: Int): Boolean {
    if (!isConvex(pts)) return false
    if (contourArea(pts) < 0.1 * w * h) return false
    val n = pts.size
    val minEdge = minOf(w, h) * 0.1
    for (i in 0 until n) {
      val a = pts[(i - 1 + n) % n]; val b = pts[i]; val c = pts[(i + 1) % n]
      val v1x = a[0] - b[0]; val v1y = a[1] - b[1]
      val v2x = c[0] - b[0]; val v2y = c[1] - b[1]
      val len1 = sqrt(v1x * v1x + v1y * v1y)
      val len2 = sqrt(v2x * v2x + v2y * v2y)
      if (len1 < minEdge || len2 < minEdge) return false
      val dot = v1x * v2x + v1y * v2y
      var cosAngle = dot / (len1 * len2)
      cosAngle = cosAngle.coerceIn(-1.0, 1.0)
      val angle = acos(cosAngle) * 180.0 / PI
      if (angle < 30 || angle > 150) return false
    }
    return true
  }

  // ── Normalize corners to 0-1 range ──

  private fun normalizeCorners(ordered: List<DoubleArray>, w: Int, h: Int): Corners {
    return Corners(
      tl = Point((ordered[0][0] / w).coerceIn(0.0, 1.0), (ordered[0][1] / h).coerceIn(0.0, 1.0)),
      tr = Point((ordered[1][0] / w).coerceIn(0.0, 1.0), (ordered[1][1] / h).coerceIn(0.0, 1.0)),
      br = Point((ordered[2][0] / w).coerceIn(0.0, 1.0), (ordered[2][1] / h).coerceIn(0.0, 1.0)),
      bl = Point((ordered[3][0] / w).coerceIn(0.0, 1.0), (ordered[3][1] / h).coerceIn(0.0, 1.0))
    )
  }

  // ── Try to find a valid quad from an approximated polygon ──

  private fun tryExtractQuad(approx: List<DoubleArray>, w: Int, h: Int): Pair<List<DoubleArray>, Double>? {
    if (approx.size == 4) {
      if (validateQuad(approx, w, h)) {
        return Pair(approx, contourArea(approx))
      }
    } else if (approx.size == 5) {
      var best: Pair<List<DoubleArray>, Double>? = null
      for (skip in 0 until 5) {
        val quad = approx.filterIndexed { k, _ -> k != skip }
        if (validateQuad(quad, w, h)) {
          val area = contourArea(quad)
          if (best == null || area > best.second) best = Pair(quad, area)
        }
      }
      return best
    }
    return null
  }

  // ── Otsu threshold ──

  private fun otsuThreshold(gray: DoubleArray, w: Int, h: Int): Int {
    val hist = DoubleArray(256)
    for (i in 0 until w * h) {
      val bin = gray[i].roundToInt().coerceIn(0, 255)
      hist[bin]++
    }
    val total = w * h
    var sumAll = 0.0
    for (i in 0 until 256) sumAll += i * hist[i]
    var sumB = 0.0; var wB = 0.0; var bestThresh = 128; var bestVar = 0.0
    for (t in 0 until 256) {
      wB += hist[t]
      if (wB == 0.0) continue
      val wF = total - wB
      if (wF == 0.0) break
      sumB += t * hist[t]
      val mB = sumB / wB
      val mF = (sumAll - sumB) / wF
      val between = wB * wF * (mB - mF) * (mB - mF)
      if (between > bestVar) { bestVar = between; bestThresh = t }
    }
    return bestThresh
  }

  // ── RANSAC line fitting ──

  private val random = java.util.Random()

  private fun ransacLine(points: List<DoubleArray>, maxIter: Int, distThresh: Double): RansacResult? {
    val n = points.size
    if (n < 2) return null
    var bestScore = 0.0
    var bestA = 0.0; var bestB = 0.0; var bestC = 0.0
    for (iter in 0 until maxIter) {
      val i1 = random.nextInt(n)
      var i2 = random.nextInt(n - 1)
      if (i2 >= i1) i2++
      val x1 = points[i1][0]; val y1 = points[i1][1]
      val x2 = points[i2][0]; val y2 = points[i2][1]
      var la = y2 - y1; var lb = x1 - x2
      var lc = x2 * y1 - x1 * y2
      val norm = sqrt(la * la + lb * lb)
      if (norm < 1e-10) continue
      la /= norm; lb /= norm; lc /= norm
      var cnt = 0; var minP = 1e9; var maxP = -1e9
      for (j in 0 until n) {
        if (abs(la * points[j][0] + lb * points[j][1] + lc) < distThresh) {
          cnt++
          val p = -lb * points[j][0] + la * points[j][1]
          if (p < minP) minP = p
          if (p > maxP) maxP = p
        }
      }
      if (cnt < 5) continue
      val sc = cnt.toDouble() * (maxP - minP)
      if (sc > bestScore) { bestScore = sc; bestA = la; bestB = lb; bestC = lc }
    }
    if (bestScore == 0.0) return null
    val mask = BooleanArray(n)
    var total = 0; var cx = 0.0; var cy = 0.0
    for (j in 0 until n) {
      if (abs(bestA * points[j][0] + bestB * points[j][1] + bestC) < distThresh) {
        mask[j] = true; total++; cx += points[j][0]; cy += points[j][1]
      }
    }
    if (total > 0) { cx /= total; cy /= total }
    return RansacResult(bestA, bestB, bestC, total, bestScore, mask, cx, cy)
  }

  private fun intersectLineEq(l1: RansacResult, l2: RansacResult): DoubleArray? {
    val det = l1.a * l2.b - l2.a * l1.b
    if (abs(det) < 1e-10) return null
    return doubleArrayOf(
      (l1.b * l2.c - l2.b * l1.c) / det,
      (l2.a * l1.c - l1.a * l2.c) / det
    )
  }

  // ══════════════════════════════════════════════════════
  // ── Primary: Gradient-direction RANSAC detection ──
  // ══════════════════════════════════════════════════════

  private fun gradientRansacDetection(gray: DoubleArray, w: Int, h: Int): Corners? {
    val blurred = gaussianBlur5x5(gaussianBlur5x5(gray, w, h), w, h)
    val (mag, dir) = sobelGradients(blurred, w, h)
    val nms = nonMaxSuppression(mag, dir, w, h)

    val allMags = mutableListOf<Double>()
    for (i in 0 until w * h) {
      if (nms[i] > 0) allMags.add(nms[i])
    }
    if (allMags.size < 50) {
      Log.d(TAG, "RANSAC: too few edge pixels (${allMags.size})")
      return null
    }
    allMags.sortDescending()

    // Precompute brightness contrast across each edge pixel:
    // sample blurred gray 3px on each side perpendicular to gradient direction
    val contrast = DoubleArray(w * h)
    val sampleR = 3
    for (py in sampleR until h - sampleR) {
      for (px in sampleR until w - sampleR) {
        if (nms[py * w + px] <= 0) continue
        val theta = dir[py * w + px]
        val cosT = cos(theta); val sinT = sin(theta)
        val nx1 = (px + cosT * sampleR).roundToInt().coerceIn(0, w - 1)
        val ny1 = (py + sinT * sampleR).roundToInt().coerceIn(0, h - 1)
        val nx2 = (px - cosT * sampleR).roundToInt().coerceIn(0, w - 1)
        val ny2 = (py - sinT * sampleR).roundToInt().coerceIn(0, h - 1)
        contrast[py * w + px] = abs(blurred[ny1 * w + nx1] - blurred[ny2 * w + nx2])
      }
    }

    // Try with contrast filter first, then without
    val contrastThresholds = doubleArrayOf(30.0, 15.0, 0.0)
    val threshFracs = doubleArrayOf(0.10, 0.20, 0.35, 0.50)

    for (contrastTh in contrastThresholds) {
    for ((ti, threshFrac) in threshFracs.withIndex()) {
      val magTh = allMags[minOf((allMags.size * threshFrac).toInt(), allMags.size - 1)]

      data class EdgePixel(val x: Int, val y: Int, val bin: Int)
      val pixels = mutableListOf<EdgePixel>()
      for (py in sampleR until h - sampleR) {
        for (px in sampleR until w - sampleR) {
          if (nms[py * w + px] < magTh) continue
          if (contrast[py * w + px] < contrastTh) continue
          var gd = dir[py * w + px]
          if (gd < 0) gd += PI
          var bin = (gd * 180.0 / PI).toInt()
          if (bin >= 180) bin = 179
          if (bin < 0) bin = 0
          pixels.add(EdgePixel(px, py, bin))
        }
      }
      if (pixels.size < 50) continue

      // Direction histogram (1-degree bins)
      val dirH = DoubleArray(180)
      for (p in pixels) dirH[p.bin]++
      // Smooth with radius 5 (circular)
      val sm = DoubleArray(180)
      for (i in 0 until 180) {
        for (j in -5..5) sm[i] += dirH[((i + j) % 180 + 180) % 180]
      }

      var pk1 = 0
      for (i in 1 until 180) { if (sm[i] > sm[pk1]) pk1 = i }

      var pk2 = -1; var pk2V = -1.0
      for (off in 60..120) {
        val idx = (pk1 + off) % 180
        if (sm[idx] > pk2V) { pk2V = sm[idx]; pk2 = idx }
      }
      if (pk2 == -1 || pk2V < sm[pk1] * 0.05) continue

      val tol = 25
      val g1 = mutableListOf<DoubleArray>()
      val g2 = mutableListOf<DoubleArray>()
      for (p in pixels) {
        var d1 = abs(p.bin - pk1); if (d1 > 90) d1 = 180 - d1
        var d2 = abs(p.bin - pk2); if (d2 > 90) d2 = 180 - d2
        if (d1 <= tol) g1.add(doubleArrayOf(p.x.toDouble(), p.y.toDouble()))
        else if (d2 <= tol) g2.add(doubleArrayOf(p.x.toDouble(), p.y.toDouble()))
      }
      if (g1.size < 20 || g2.size < 20) continue

      Log.d(TAG, "RANSAC cTh=$contrastTh ti=$ti: pixels=${pixels.size} pk1=$pk1 pk2=$pk2 g1=${g1.size} g2=${g2.size}")

      val dThr = maxOf(2.0, minOf(w, h) * 0.006)
      val groups = listOf(g1, g2)
      val allLines = Array(2) { mutableListOf<RansacResult>() }

      var groupsOk = true
      for (gi in 0..1) {
        var rem = groups[gi].toList()
        for (li in 0 until 8) {
          if (rem.size <= 10) break
          val ln = ransacLine(rem, 1500, dThr) ?: break
          if (ln.count < 5) break
          allLines[gi].add(ln)
          val newRem = mutableListOf<DoubleArray>()
          for (ri in rem.indices) {
            if (!ln.inlierMask[ri]) newRem.add(rem[ri])
          }
          rem = newRem
        }
        Log.d(TAG, "RANSAC gi=$gi: ${allLines[gi].size} lines, counts=[${allLines[gi].joinToString(",") { it.count.toString() }}]")
        if (allLines[gi].size < 2) { groupsOk = false; break }
      }
      if (!groupsOk) continue

      // Try ALL combinations of (2 lines from group0) × (2 lines from group1)
      // Pick the largest valid quad
      val margin = maxOf(w, h) * 0.15
      var bestQuadArea = 0.0
      var bestOrdered: List<DoubleArray>? = null

      val lines0 = allLines[0]
      val lines1 = allLines[1]
      for (i0 in lines0.indices) {
        for (j0 in i0 + 1 until lines0.size) {
          for (i1 in lines1.indices) {
            for (j1 in i1 + 1 until lines1.size) {
              // Intersect 4 line pairs → 4 corners
              val c00 = intersectLineEq(lines0[i0], lines1[i1]) ?: continue
              val c01 = intersectLineEq(lines0[i0], lines1[j1]) ?: continue
              val c10 = intersectLineEq(lines0[j0], lines1[i1]) ?: continue
              val c11 = intersectLineEq(lines0[j0], lines1[j1]) ?: continue
              val corners = listOf(c00, c01, c10, c11)

              // Bounds check
              var inBounds = true
              for (c in corners) {
                if (c[0] < -margin || c[0] > w + margin || c[1] < -margin || c[1] > h + margin) {
                  inBounds = false; break
                }
              }
              if (!inBounds) continue

              val ordered = orderCorners(corners)
              if (!validateQuad(ordered, w, h)) continue
              val area = contourArea(ordered)
              if (area > bestQuadArea) {
                bestQuadArea = area
                bestOrdered = ordered
              }
            }
          }
        }
      }

      if (bestOrdered != null) {
        Log.d(TAG, "RANSAC cTh=$contrastTh: found quad, area=%.0f (${lines0.size}x${lines1.size} lines)".format(bestQuadArea))
        return normalizeCorners(bestOrdered, w, h)
      }
      Log.d(TAG, "RANSAC cTh=$contrastTh ti=$ti: no valid quad from ${lines0.size}x${lines1.size} line combos")
    }
    }
    return null
  }

  // ══════════════════════════════════════════════════════
  // ── Secondary: Segment-based detection ──
  // ══════════════════════════════════════════════════════

  private fun segmentBasedDetection(gray: DoubleArray, w: Int, h: Int): Corners? {
    var blurred = gaussianBlur5x5(gray, w, h)
    blurred = gaussianBlur5x5(blurred, w, h)
    blurred = gaussianBlur5x5(blurred, w, h)

    val thresh = otsuThreshold(blurred, w, h)
    var bestQuad: List<DoubleArray>? = null; var bestArea = 0.0

    for (pol in 0..1) {
      val binary = IntArray(w * h)
      for (i in 0 until w * h) {
        binary[i] = if (if (pol == 0) blurred[i] > thresh else blurred[i] <= thresh) 255 else 0
      }

      var closed = dilateEdgesR(binary, w, h, 3)
      closed = erodeR(closed, w, h, 3)

      val (labels, comps) = labelComponents(closed, w, h)
      val sortedComps = comps.sortedByDescending { it.size }

      for (ci in 0 until minOf(3, sortedComps.size)) {
        val comp = sortedComps[ci]
        if (comp.size < 0.05 * w * h || comp.size > 0.95 * w * h) continue

        val boundary = mutableListOf<DoubleArray>()
        val tgt = comp.label
        for (y in 0 until h) {
          for (x in 0 until w) {
            if (labels[y * w + x] != tgt) continue
            var onB = x == 0 || x == w - 1 || y == 0 || y == h - 1
            if (!onB) {
              loop@ for (dy in -1..1) {
                for (dx in -1..1) {
                  if (dx == 0 && dy == 0) continue
                  if (labels[(y + dy) * w + (x + dx)] != tgt) { onB = true; break@loop }
                }
              }
            }
            if (onB) boundary.add(doubleArrayOf(x.toDouble(), y.toDouble()))
          }
        }

        if (boundary.size < 20) continue
        val hull = convexHull(boundary)
        if (hull.size < 4) continue
        val hullArea = contourArea(hull)
        if (hullArea > 0.9 * w * h || hullArea < 0.05 * w * h) continue

        var peri = 0.0
        for (i in hull.indices) {
          val j = (i + 1) % hull.size
          val ddx = hull[j][0] - hull[i][0]; val ddy = hull[j][1] - hull[i][1]
          peri += sqrt(ddx * ddx + ddy * ddy)
        }

        val epsilons = doubleArrayOf(0.015, 0.02, 0.03, 0.04, 0.06)
        for (eps in epsilons) {
          val approx = douglasPeucker(hull, eps * peri)
          val found = tryExtractQuad(approx, w, h)
          if (found != null && found.second > bestArea) {
            bestArea = found.second; bestQuad = found.first
          }
        }
      }
      if (bestQuad != null) break
    }

    if (bestQuad == null) return null
    return normalizeCorners(orderCorners(bestQuad), w, h)
  }

  // ══════════════════════════════════════════════════════
  // ── Tertiary: Contour-based detection ──
  // ══════════════════════════════════════════════════════

  private fun contourBasedDetection(edges: IntArray, w: Int, h: Int): Corners? {
    var bestQuad: List<DoubleArray>? = null; var bestArea = 0.0
    val radii = intArrayOf(2, 4, 8)
    val epsilons = doubleArrayOf(0.015, 0.02, 0.03, 0.04, 0.06, 0.08)

    for (radius in radii) {
      val dilated = dilateEdgesR(edges, w, h, radius)
      val (labels, comps) = labelComponents(dilated, w, h)
      val sortedComps = comps.sortedByDescending { it.size }

      val compEdgePx = mutableMapOf<Int, MutableList<DoubleArray>>()
      for (y in 0 until h) {
        for (x in 0 until w) {
          if (edges[y * w + x] != 255) continue
          val lbl = labels[y * w + x]
          if (lbl > 0) {
            compEdgePx.getOrPut(lbl) { mutableListOf() }.add(doubleArrayOf(x.toDouble(), y.toDouble()))
          }
        }
      }

      val topN = minOf(5, sortedComps.size)
      for (ci in 0 until topN) {
        val pts = compEdgePx[sortedComps[ci].label] ?: continue
        if (pts.size < 20) continue
        val hull = convexHull(pts)
        if (hull.size < 4) continue
        val hullArea = contourArea(hull)
        if (hullArea > 0.9 * w * h) continue

        var peri = 0.0
        for (i in hull.indices) {
          val j = (i + 1) % hull.size
          val ddx = hull[j][0] - hull[i][0]; val ddy = hull[j][1] - hull[i][1]
          peri += sqrt(ddx * ddx + ddy * ddy)
        }

        for (eps in epsilons) {
          val approx = douglasPeucker(hull, eps * peri)
          val found = tryExtractQuad(approx, w, h)
          if (found != null && found.second > bestArea) {
            bestArea = found.second; bestQuad = found.first
          }
        }
      }
      if (bestQuad != null) break
    }

    if (bestQuad == null) return null
    return normalizeCorners(orderCorners(bestQuad), w, h)
  }

  // ══════════════════════════════════════════════════════
  // ── Quaternary: Hough line detection ──
  // ══════════════════════════════════════════════════════

  private fun houghLines(edges: IntArray, w: Int, h: Int): List<HoughLine> {
    val maxRho = ceil(sqrt((w * w + h * h).toDouble())).toInt()
    val thetaSteps = 180
    val rhoSize = maxRho * 2 + 1
    val acc = IntArray(rhoSize * thetaSteps)

    val cosTable = DoubleArray(thetaSteps)
    val sinTable = DoubleArray(thetaSteps)
    for (t in 0 until thetaSteps) {
      val theta = (t * PI) / thetaSteps
      cosTable[t] = cos(theta); sinTable[t] = sin(theta)
    }
    for (y in 0 until h) {
      for (x in 0 until w) {
        if (edges[y * w + x] == 0) continue
        for (t in 0 until thetaSteps) {
          val rho = (x * cosTable[t] + y * sinTable[t]).roundToInt() + maxRho
          acc[rho * thetaSteps + t]++
        }
      }
    }

    val threshold = maxOf(w, h) * 0.08
    val lines = mutableListOf<HoughLine>()
    val nmsRadius = 5
    for (r in 0 until rhoSize) {
      for (t in 0 until thetaSteps) {
        val votes = acc[r * thetaSteps + t]
        if (votes < threshold) continue
        var isMax = true
        loop@ for (dr in -nmsRadius..nmsRadius) {
          for (dt in -nmsRadius..nmsRadius) {
            if (dr == 0 && dt == 0) continue
            val nr = r + dr; val nt = t + dt
            if (nr < 0 || nr >= rhoSize || nt < 0 || nt >= thetaSteps) continue
            if (acc[nr * thetaSteps + nt] > votes) { isMax = false; break@loop }
          }
        }
        if (isMax) lines.add(HoughLine(r - maxRho, (t * PI) / thetaSteps, votes))
      }
    }
    return lines.sortedByDescending { it.votes }
  }

  private fun lineIntersection(l1: HoughLine, l2: HoughLine): DoubleArray? {
    val cos1 = cos(l1.theta); val sin1 = sin(l1.theta)
    val cos2 = cos(l2.theta); val sin2 = sin(l2.theta)
    val det = cos1 * sin2 - cos2 * sin1
    if (abs(det) < 1e-10) return null
    return doubleArrayOf(
      (l1.rho * sin2 - l2.rho * sin1) / det,
      (l2.rho * cos1 - l1.rho * cos2) / det
    )
  }

  private fun findBestQuad(lines: List<HoughLine>, w: Int, h: Int): Corners? {
    if (lines.size < 4) return null

    val horizontal = mutableListOf<HoughLine>()
    val vertical = mutableListOf<HoughLine>()
    for (l in lines) {
      val deg = l.theta * 180.0 / PI
      if (deg > 30 && deg < 150) horizontal.add(l)
      if (deg < 60 || deg > 120) vertical.add(l)
    }
    if (horizontal.size < 2 || vertical.size < 2) return null
    val hLines = horizontal.take(8)
    val vLines = vertical.take(8)

    var maxSpreadH = 0.0
    for (i in hLines.indices) {
      for (j in i + 1 until hLines.size) {
        val y1 = hLines[i].rho / sin(hLines[i].theta)
        val y2 = hLines[j].rho / sin(hLines[j].theta)
        if (abs(y1 - y2) > maxSpreadH) maxSpreadH = abs(y1 - y2)
      }
    }
    var bestH: Array<HoughLine>? = null; var bestHScore = 0.0
    for (i in hLines.indices) {
      for (j in i + 1 until hLines.size) {
        val y1 = hLines[i].rho / sin(hLines[i].theta)
        val y2 = hLines[j].rho / sin(hLines[j].theta)
        val spread = abs(y1 - y2)
        val score = (hLines[i].votes + hLines[j].votes) * (0.6 + 0.4 * spread / maxOf(maxSpreadH, 1.0))
        if (score > bestHScore) {
          bestHScore = score
          bestH = if (y1 < y2) arrayOf(hLines[i], hLines[j]) else arrayOf(hLines[j], hLines[i])
        }
      }
    }

    var maxSpreadV = 0.0
    for (i in vLines.indices) {
      for (j in i + 1 until vLines.size) {
        val x1 = vLines[i].rho / cos(vLines[i].theta)
        val x2 = vLines[j].rho / cos(vLines[j].theta)
        if (abs(x1 - x2) > maxSpreadV) maxSpreadV = abs(x1 - x2)
      }
    }
    var bestV: Array<HoughLine>? = null; var bestVScore = 0.0
    for (i in vLines.indices) {
      for (j in i + 1 until vLines.size) {
        val x1 = vLines[i].rho / cos(vLines[i].theta)
        val x2 = vLines[j].rho / cos(vLines[j].theta)
        val spread = abs(x1 - x2)
        val score = (vLines[i].votes + vLines[j].votes) * (0.6 + 0.4 * spread / maxOf(maxSpreadV, 1.0))
        if (score > bestVScore) {
          bestVScore = score
          bestV = if (x1 < x2) arrayOf(vLines[i], vLines[j]) else arrayOf(vLines[j], vLines[i])
        }
      }
    }

    if (bestH == null || bestV == null) return null
    val tl = lineIntersection(bestH[0], bestV[0]) ?: return null
    val tr = lineIntersection(bestH[0], bestV[1]) ?: return null
    val br = lineIntersection(bestH[1], bestV[1]) ?: return null
    val bl = lineIntersection(bestH[1], bestV[0]) ?: return null

    val margin = -0.1 * maxOf(w, h)
    val limit = 1.1 * maxOf(w, h)
    for (p in listOf(tl, tr, br, bl)) {
      if (p[0] < margin || p[0] > limit || p[1] < margin || p[1] > limit) return null
    }

    val quadArea = 0.5 * abs(
      (tr[0] - tl[0]) * (bl[1] - tl[1]) - (bl[0] - tl[0]) * (tr[1] - tl[1]) +
      (br[0] - tr[0]) * (tl[1] - tr[1]) - (tl[0] - tr[0]) * (br[1] - tr[1]) +
      (bl[0] - br[0]) * (tr[1] - br[1]) - (tr[0] - br[0]) * (bl[1] - br[1]) +
      (tl[0] - bl[0]) * (br[1] - bl[1]) - (br[0] - bl[0]) * (tl[1] - bl[1])
    )
    if (quadArea < 0.1 * w * h) return null

    return Corners(
      tl = Point((tl[0] / w).coerceIn(0.0, 1.0), (tl[1] / h).coerceIn(0.0, 1.0)),
      tr = Point((tr[0] / w).coerceIn(0.0, 1.0), (tr[1] / h).coerceIn(0.0, 1.0)),
      br = Point((br[0] / w).coerceIn(0.0, 1.0), (br[1] / h).coerceIn(0.0, 1.0)),
      bl = Point((bl[0] / w).coerceIn(0.0, 1.0), (bl[1] / h).coerceIn(0.0, 1.0))
    )
  }
}
