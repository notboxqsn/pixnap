/**
 * Generates the HTML/JS that runs inside a WebView to perform
 * perspective correction and image enhancement entirely on the client.
 *
 * Communication protocol (postMessage JSON):
 *   RN -> WebView: { type:'process', base64, corners: {tl,tr,br,bl}, mode: 'bw'|'gray'|'color' }
 *   RN -> WebView: { type:'detect', base64 }
 *   RN -> WebView: { type:'previewFilters', base64, corners: {tl,tr,br,bl} }
 *   WebView -> RN: { type:'result', base64, width, height }
 *   WebView -> RN: { type:'corners', corners: {tl,tr,br,bl} | null }
 *   WebView -> RN: { type:'filterPreviews', bw: base64, gray: base64, color: base64 }
 *   WebView -> RN: { type:'error', message }
 */
export function getScannerHtml(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;background:#000}canvas{display:none}</style></head>
<body>
<canvas id="src"></canvas><canvas id="dst"></canvas>
<script>
'use strict';

// ── Gaussian elimination for solving Ax = b ──
function solve(A, b) {
  var n = b.length;
  // augmented matrix
  var M = [];
  for (var i = 0; i < n; i++) {
    M[i] = A[i].slice();
    M[i].push(b[i]);
  }
  for (var col = 0; col < n; col++) {
    // pivot
    var maxRow = col;
    for (var row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    }
    var tmp = M[col]; M[col] = M[maxRow]; M[maxRow] = tmp;
    if (Math.abs(M[col][col]) < 1e-10) return null;
    for (var row = col + 1; row < n; row++) {
      var f = M[row][col] / M[col][col];
      for (var j = col; j <= n; j++) M[row][j] -= f * M[col][j];
    }
  }
  var x = new Array(n);
  for (var i = n - 1; i >= 0; i--) {
    x[i] = M[i][n];
    for (var j = i + 1; j < n; j++) x[i] -= M[i][j] * x[j];
    x[i] /= M[i][i];
  }
  return x;
}

// ── Compute 3×3 homography mapping src quad -> dst rect (DLT) ──
function computeHomography(srcPts, dstPts) {
  // srcPts/dstPts: [[x0,y0],[x1,y1],[x2,y2],[x3,y3]]
  var A = [], b = [];
  for (var i = 0; i < 4; i++) {
    var sx = srcPts[i][0], sy = srcPts[i][1];
    var dx = dstPts[i][0], dy = dstPts[i][1];
    A.push([sx, sy, 1, 0, 0, 0, -dx*sx, -dx*sy]);
    b.push(dx);
    A.push([0, 0, 0, sx, sy, 1, -dy*sx, -dy*sy]);
    b.push(dy);
  }
  var h = solve(A, b);
  if (!h) return null;
  // H = [[h0,h1,h2],[h3,h4,h5],[h6,h7,1]]
  return [h[0],h[1],h[2],h[3],h[4],h[5],h[6],h[7],1];
}

// ── Invert 3×3 matrix ──
function invert3x3(m) {
  var a=m[0],b=m[1],c=m[2],d=m[3],e=m[4],f=m[5],g=m[6],h=m[7],k=m[8];
  var det = a*(e*k-f*h) - b*(d*k-f*g) + c*(d*h-e*g);
  if (Math.abs(det) < 1e-10) return null;
  var inv = 1/det;
  return [
    (e*k-f*h)*inv, (c*h-b*k)*inv, (b*f-c*e)*inv,
    (f*g-d*k)*inv, (a*k-c*g)*inv, (c*d-a*f)*inv,
    (d*h-e*g)*inv, (b*g-a*h)*inv, (a*e-b*d)*inv
  ];
}

function dist(p1, p2) {
  return Math.sqrt((p1[0]-p2[0])*(p1[0]-p2[0]) + (p1[1]-p2[1])*(p1[1]-p2[1]));
}

// ── Perspective warp with inlined bilinear interpolation ──
function warp(srcData, sw, sh, H_inv, dw, dh) {
  var out = new Uint8ClampedArray(dw * dh * 4);
  var h0 = H_inv[0], h1 = H_inv[1], h2 = H_inv[2];
  var h3 = H_inv[3], h4 = H_inv[4], h5 = H_inv[5];
  var h6 = H_inv[6], h7 = H_inv[7], h8 = H_inv[8];
  var sw1 = sw - 1, sh1 = sh - 1;
  for (var dy = 0; dy < dh; dy++) {
    var rw = h7*dy + h8;
    var rx = h1*dy + h2;
    var ry = h4*dy + h5;
    for (var dx = 0; dx < dw; dx++) {
      var w = h6*dx + rw;
      var sx = (h0*dx + rx) / w;
      var sy = (h3*dx + ry) / w;
      var idx = (dy*dw+dx)*4;
      if (sx >= 0 && sx < sw && sy >= 0 && sy < sh) {
        var x0 = sx|0, y0 = sy|0;
        var x1 = x0 < sw1 ? x0+1 : sw1;
        var y1 = y0 < sh1 ? y0+1 : sh1;
        var fx = sx - x0, fy = sy - y0;
        var fx1 = 1-fx, fy1 = 1-fy;
        var w00 = fx1*fy1, w10 = fx*fy1, w01 = fx1*fy, w11 = fx*fy;
        var i00 = (y0*sw+x0)*4, i10 = (y0*sw+x1)*4;
        var i01 = (y1*sw+x0)*4, i11 = (y1*sw+x1)*4;
        out[idx]   = srcData[i00]*w00 + srcData[i10]*w10 + srcData[i01]*w01 + srcData[i11]*w11;
        out[idx+1] = srcData[i00+1]*w00 + srcData[i10+1]*w10 + srcData[i01+1]*w01 + srcData[i11+1]*w11;
        out[idx+2] = srcData[i00+2]*w00 + srcData[i10+2]*w10 + srcData[i01+2]*w01 + srcData[i11+2]*w11;
        out[idx+3] = 255;
      }
    }
  }
  return out;
}

// ── Adaptive threshold (integral image) ──
function adaptiveThreshold(gray, w, h, blockSize, C) {
  // Build integral image
  var integral = new Float64Array((w+1)*(h+1));
  for (var y = 0; y < h; y++) {
    var rowSum = 0;
    for (var x = 0; x < w; x++) {
      rowSum += gray[y*w+x];
      integral[(y+1)*(w+1)+(x+1)] = integral[y*(w+1)+(x+1)] + rowSum;
    }
  }
  var out = new Uint8ClampedArray(w*h);
  var half = Math.floor(blockSize/2);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var x1 = Math.max(0, x-half), y1 = Math.max(0, y-half);
      var x2 = Math.min(w-1, x+half), y2 = Math.min(h-1, y+half);
      var area = (x2-x1+1)*(y2-y1+1);
      var sum = integral[(y2+1)*(w+1)+(x2+1)] - integral[y1*(w+1)+(x2+1)]
              - integral[(y2+1)*(w+1)+x1] + integral[y1*(w+1)+x1];
      var mean = sum / area;
      out[y*w+x] = gray[y*w+x] < (mean - C) ? 0 : 255;
    }
  }
  return out;
}

// ── toGray ──
function toGray(data, w, h) {
  var n = w*h;
  var gray = new Uint8Array(n);
  for (var i = 0; i < n; i++) {
    gray[i] = (0.299*data[i*4] + 0.587*data[i*4+1] + 0.114*data[i*4+2] + 0.5)|0;
  }
  return gray;
}

// ── Histogram-based percentile (O(n) instead of O(n log n) sort) ──
function histPercentile(hist, total, pct) {
  var target = Math.floor(total * pct);
  var sum = 0;
  for (var i = 0; i < 256; i++) {
    sum += hist[i];
    if (sum > target) return i;
  }
  return 255;
}

// ── Enhancement modes ──
function enhanceBW(data, w, h) {
  var gray = toGray(data, w, h);
  var blockSize = Math.max(15, Math.round(Math.min(w,h)/8)|1);
  if (blockSize % 2 === 0) blockSize++;
  var bw = adaptiveThreshold(gray, w, h, blockSize, 10);
  for (var i = 0; i < w*h; i++) {
    if (data[i*4+3] === 0) continue;
    data[i*4] = data[i*4+1] = data[i*4+2] = bw[i];
  }
}

function enhanceGray(data, w, h) {
  var n = w * h;
  var gray = toGray(data, w, h);
  var hist = new Uint32Array(256);
  var valid = 0;
  for (var i = 0; i < n; i++) {
    if (data[i*4+3] === 0) continue;
    hist[gray[i]]++;
    valid++;
  }
  if (valid === 0) return;
  var lo = histPercentile(hist, valid, 0.01);
  var hi = histPercentile(hist, valid, 0.99);
  var range = hi - lo || 1;
  for (var i = 0; i < n; i++) {
    if (data[i*4+3] === 0) continue;
    var v = Math.round(((gray[i]-lo)/range)*255);
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    data[i*4] = data[i*4+1] = data[i*4+2] = v;
  }
}

function enhanceColor(data, w, h) {
  var n = w * h;
  for (var c = 0; c < 3; c++) {
    var hist = new Uint32Array(256);
    var valid = 0;
    for (var i = 0; i < n; i++) {
      if (data[i*4+3] === 0) continue;
      hist[data[i*4+c]]++;
      valid++;
    }
    if (valid === 0) continue;
    var lo = histPercentile(hist, valid, 0.01);
    var hi = histPercentile(hist, valid, 0.99);
    var range = hi - lo || 1;
    for (var i = 0; i < n; i++) {
      if (data[i*4+3] === 0) continue;
      var v = ((data[i*4+c]-lo)/range)*255;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      data[i*4+c] = Math.round(v);
    }
  }
}

// ── Document boundary detection ──

function gaussianBlur5x5(gray, w, h) {
  var kernel = [
    1, 4, 7, 4, 1,
    4,16,26,16, 4,
    7,26,41,26, 7,
    4,16,26,16, 4,
    1, 4, 7, 4, 1
  ];
  var kSum = 273;
  var out = new Float64Array(w * h);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var sum = 0;
      for (var ky = -2; ky <= 2; ky++) {
        for (var kx = -2; kx <= 2; kx++) {
          var py = Math.min(Math.max(y + ky, 0), h - 1);
          var px = Math.min(Math.max(x + kx, 0), w - 1);
          sum += gray[py * w + px] * kernel[(ky + 2) * 5 + (kx + 2)];
        }
      }
      out[y * w + x] = sum / kSum;
    }
  }
  return out;
}

function sobelGradients(gray, w, h) {
  var mag = new Float64Array(w * h);
  var dir = new Float64Array(w * h);
  for (var y = 1; y < h - 1; y++) {
    for (var x = 1; x < w - 1; x++) {
      var gx = -gray[(y-1)*w+(x-1)] + gray[(y-1)*w+(x+1)]
              -2*gray[y*w+(x-1)]    + 2*gray[y*w+(x+1)]
              -gray[(y+1)*w+(x-1)]  + gray[(y+1)*w+(x+1)];
      var gy = -gray[(y-1)*w+(x-1)] - 2*gray[(y-1)*w+x] - gray[(y-1)*w+(x+1)]
              +gray[(y+1)*w+(x-1)]  + 2*gray[(y+1)*w+x]  + gray[(y+1)*w+(x+1)];
      mag[y * w + x] = Math.sqrt(gx * gx + gy * gy);
      dir[y * w + x] = Math.atan2(gy, gx);
    }
  }
  return { mag: mag, dir: dir };
}

function nonMaxSuppression(mag, dir, w, h) {
  var out = new Float64Array(w * h);
  for (var y = 1; y < h - 1; y++) {
    for (var x = 1; x < w - 1; x++) {
      var angle = dir[y * w + x] * 180 / Math.PI;
      if (angle < 0) angle += 180;
      var m = mag[y * w + x];
      var n1 = 0, n2 = 0;
      if ((angle < 22.5) || (angle >= 157.5)) {
        n1 = mag[y * w + (x - 1)];
        n2 = mag[y * w + (x + 1)];
      } else if (angle < 67.5) {
        n1 = mag[(y - 1) * w + (x + 1)];
        n2 = mag[(y + 1) * w + (x - 1)];
      } else if (angle < 112.5) {
        n1 = mag[(y - 1) * w + x];
        n2 = mag[(y + 1) * w + x];
      } else {
        n1 = mag[(y - 1) * w + (x - 1)];
        n2 = mag[(y + 1) * w + (x + 1)];
      }
      out[y * w + x] = (m >= n1 && m >= n2) ? m : 0;
    }
  }
  return out;
}

function cannyEdges(gray, w, h) {
  var blurred = gaussianBlur5x5(gray, w, h);
  var grad = sobelGradients(blurred, w, h);
  var nms = nonMaxSuppression(grad.mag, grad.dir, w, h);
  // Auto threshold using Otsu on gradient magnitudes
  var maxMag = 0;
  for (var i = 0; i < w * h; i++) {
    if (nms[i] > maxMag) maxMag = nms[i];
  }
  if (maxMag < 1) return new Uint8Array(w * h);
  var histSize = 256;
  var hist = new Float64Array(histSize);
  for (var i = 0; i < w * h; i++) {
    var bin = Math.min(Math.floor(nms[i] / maxMag * 255), 255);
    hist[bin]++;
  }
  var total = w * h;
  var sumAll = 0;
  for (var i = 0; i < histSize; i++) sumAll += i * hist[i];
  var sumB = 0, wB = 0, bestThresh = 0, bestVar = 0;
  for (var t = 0; t < histSize; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    var wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    var mB = sumB / wB;
    var mF = (sumAll - sumB) / wF;
    var between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      bestThresh = t;
    }
  }
  var highThresh = (bestThresh / 255) * maxMag;
  var lowThresh = highThresh * 0.5;
  // Hysteresis thresholding
  var edges = new Uint8Array(w * h);
  var strong = 255, weak = 128;
  for (var i = 0; i < w * h; i++) {
    if (nms[i] >= highThresh) edges[i] = strong;
    else if (nms[i] >= lowThresh) edges[i] = weak;
  }
  var changed = true;
  while (changed) {
    changed = false;
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        if (edges[y * w + x] !== weak) continue;
        if (edges[(y-1)*w+(x-1)] === strong || edges[(y-1)*w+x] === strong ||
            edges[(y-1)*w+(x+1)] === strong || edges[y*w+(x-1)] === strong ||
            edges[y*w+(x+1)] === strong || edges[(y+1)*w+(x-1)] === strong ||
            edges[(y+1)*w+x] === strong || edges[(y+1)*w+(x+1)] === strong) {
          edges[y * w + x] = strong;
          changed = true;
        }
      }
    }
  }
  for (var i = 0; i < w * h; i++) {
    edges[i] = edges[i] === strong ? 255 : 0;
  }
  return edges;
}

function dilateEdgesR(edges, w, h, radius) {
  var out = new Uint8Array(w * h);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      if (edges[y * w + x] !== 255) continue;
      for (var dy = -radius; dy <= radius; dy++) {
        for (var dx = -radius; dx <= radius; dx++) {
          var ny = y + dy, nx = x + dx;
          if (ny >= 0 && ny < h && nx >= 0 && nx < w) {
            out[ny * w + nx] = 255;
          }
        }
      }
    }
  }
  return out;
}

function erodeR(bin, w, h, radius) {
  var out = new Uint8Array(w * h);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      if (bin[y * w + x] !== 255) continue;
      var all = true;
      for (var dy = -radius; dy <= radius && all; dy++) {
        for (var dx = -radius; dx <= radius && all; dx++) {
          var ny = y + dy, nx = x + dx;
          if (ny < 0 || ny >= h || nx < 0 || nx >= w || bin[ny * w + nx] !== 255) all = false;
        }
      }
      if (all) out[y * w + x] = 255;
    }
  }
  return out;
}

function labelComponents(bin, w, h) {
  var labels = new Int32Array(w * h);
  var comps = [];
  var label = 0;
  var dx8 = [1, 1, 0, -1, -1, -1, 0, 1];
  var dy8 = [0, 1, 1, 1, 0, -1, -1, -1];
  for (var sy = 0; sy < h; sy++) {
    for (var sx = 0; sx < w; sx++) {
      if (bin[sy * w + sx] === 0 || labels[sy * w + sx] !== 0) continue;
      label++;
      var stack = [sy * w + sx];
      labels[sy * w + sx] = label;
      var cnt = 0;
      while (stack.length > 0) {
        var idx = stack.pop();
        cnt++;
        var cx = idx % w, cy = (idx / w) | 0;
        for (var d = 0; d < 8; d++) {
          var nx = cx + dx8[d], ny = cy + dy8[d];
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            var nIdx = ny * w + nx;
            if (bin[nIdx] === 255 && labels[nIdx] === 0) {
              labels[nIdx] = label;
              stack.push(nIdx);
            }
          }
        }
      }
      comps.push({ label: label, size: cnt });
    }
  }
  return { labels: labels, comps: comps };
}

function convexHull(points) {
  if (points.length < 3) return points.slice();
  var pts = points.slice().sort(function(a, b) { return a[0] - b[0] || a[1] - b[1]; });
  var unique = [pts[0]];
  for (var i = 1; i < pts.length; i++) {
    if (pts[i][0] !== pts[i - 1][0] || pts[i][1] !== pts[i - 1][1]) unique.push(pts[i]);
  }
  pts = unique;
  if (pts.length < 3) return pts;
  function cross(O, A, B) {
    return (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0]);
  }
  var lower = [];
  for (var i = 0; i < pts.length; i++) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
    lower.push(pts[i]);
  }
  var upper = [];
  for (var i = pts.length - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
    upper.push(pts[i]);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function douglasPeucker(points, epsilon) {
  if (points.length <= 2) return points.slice();
  var stack = [[0, points.length - 1]];
  var keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  while (stack.length > 0) {
    var pair = stack.pop();
    var si = pair[0], ei = pair[1];
    var maxDist = 0, maxIdx = si;
    var sx = points[si][0], sy = points[si][1];
    var ex = points[ei][0], ey = points[ei][1];
    var dx = ex - sx, dy = ey - sy;
    var lenSq = dx * dx + dy * dy;
    for (var i = si + 1; i < ei; i++) {
      var d;
      if (lenSq < 1e-10) {
        d = Math.sqrt((points[i][0] - sx) * (points[i][0] - sx) + (points[i][1] - sy) * (points[i][1] - sy));
      } else {
        d = Math.abs(dy * points[i][0] - dx * points[i][1] + ex * sy - ey * sx) / Math.sqrt(lenSq);
      }
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > epsilon) {
      keep[maxIdx] = 1;
      stack.push([si, maxIdx]);
      stack.push([maxIdx, ei]);
    }
  }
  var result = [];
  for (var i = 0; i < points.length; i++) {
    if (keep[i]) result.push(points[i]);
  }
  return result;
}

function contourArea(pts) {
  var area = 0;
  for (var i = 0; i < pts.length; i++) {
    var j = (i + 1) % pts.length;
    area += pts[i][0] * pts[j][1];
    area -= pts[j][0] * pts[i][1];
  }
  return Math.abs(area) / 2;
}

function isConvex(pts) {
  var n = pts.length;
  if (n < 3) return false;
  var sign = 0;
  for (var i = 0; i < n; i++) {
    var a = pts[i], b = pts[(i + 1) % n], c = pts[(i + 2) % n];
    var cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-6) continue;
    if (sign === 0) sign = cross > 0 ? 1 : -1;
    else if ((cross > 0 ? 1 : -1) !== sign) return false;
  }
  return sign !== 0;
}

function orderCorners(pts) {
  var sorted = pts.slice().sort(function(a, b) { return a[1] - b[1]; });
  var top = sorted.slice(0, 2).sort(function(a, b) { return a[0] - b[0]; });
  var bot = sorted.slice(2, 4).sort(function(a, b) { return a[0] - b[0]; });
  return [top[0], top[1], bot[1], bot[0]]; // tl, tr, br, bl
}

function normalizeQuad(ordered, w, h) {
  return {
    tl: { x: Math.max(0, Math.min(1, ordered[0][0] / w)), y: Math.max(0, Math.min(1, ordered[0][1] / h)) },
    tr: { x: Math.max(0, Math.min(1, ordered[1][0] / w)), y: Math.max(0, Math.min(1, ordered[1][1] / h)) },
    br: { x: Math.max(0, Math.min(1, ordered[2][0] / w)), y: Math.max(0, Math.min(1, ordered[2][1] / h)) },
    bl: { x: Math.max(0, Math.min(1, ordered[3][0] / w)), y: Math.max(0, Math.min(1, ordered[3][1] / h)) },
  };
}

function validateQuad(pts, w, h) {
  if (!isConvex(pts)) return false;
  if (contourArea(pts) < 0.1 * w * h) return false;
  var n = pts.length;
  var minEdge = Math.min(w, h) * 0.1;
  for (var i = 0; i < n; i++) {
    var a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    var v1x = a[0] - b[0], v1y = a[1] - b[1];
    var v2x = c[0] - b[0], v2y = c[1] - b[1];
    var len1 = Math.sqrt(v1x * v1x + v1y * v1y);
    var len2 = Math.sqrt(v2x * v2x + v2y * v2y);
    if (len1 < minEdge || len2 < minEdge) return false;
    var dot = v1x * v2x + v1y * v2y;
    var cosAngle = dot / (len1 * len2);
    cosAngle = Math.max(-1, Math.min(1, cosAngle));
    var angle = Math.acos(cosAngle) * 180 / Math.PI;
    if (angle < 30 || angle > 150) return false;
  }
  return true;
}

function tryFitQuadFromHull(hull, epsilons, w, h, bestQuad, bestArea) {
  var peri = 0;
  for (var i = 0; i < hull.length; i++) {
    var j = (i + 1) % hull.length;
    var ddx = hull[j][0] - hull[i][0], ddy = hull[j][1] - hull[i][1];
    peri += Math.sqrt(ddx * ddx + ddy * ddy);
  }
  for (var ei = 0; ei < epsilons.length; ei++) {
    var approx = douglasPeucker(hull, epsilons[ei] * peri);
    if (approx.length === 4) {
      if (validateQuad(approx, w, h)) {
        var area = contourArea(approx);
        if (area > bestArea) { bestArea = area; bestQuad = approx; }
      }
    } else if (approx.length === 5) {
      for (var skip = 0; skip < 5; skip++) {
        var quad = [];
        for (var k = 0; k < 5; k++) { if (k !== skip) quad.push(approx[k]); }
        if (validateQuad(quad, w, h)) {
          var area = contourArea(quad);
          if (area > bestArea) { bestArea = area; bestQuad = quad; }
        }
      }
    }
  }
  return { bestQuad: bestQuad, bestArea: bestArea };
}

function contourBasedDetection(edges, w, h) {
  var bestQuad = null, bestArea = 0;
  var radii = [2, 4, 8];
  var epsilons = [0.015, 0.02, 0.03, 0.04, 0.06, 0.08];

  for (var ri = 0; ri < radii.length; ri++) {
    var dilated = dilateEdgesR(edges, w, h, radii[ri]);
    var result = labelComponents(dilated, w, h);
    var labels = result.labels;
    var comps = result.comps;
    comps.sort(function(a, b) { return b.size - a.size; });

    // Collect original edge pixels per component
    var compEdgePx = {};
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (edges[y * w + x] !== 255) continue;
        var lbl = labels[y * w + x];
        if (lbl > 0) {
          if (!compEdgePx[lbl]) compEdgePx[lbl] = [];
          compEdgePx[lbl].push([x, y]);
        }
      }
    }

    var topN = Math.min(5, comps.length);
    for (var ci = 0; ci < topN; ci++) {
      var pts = compEdgePx[comps[ci].label];
      if (!pts || pts.length < 20) continue;

      var hull = convexHull(pts);
      if (hull.length < 4) continue;

      var hullArea = contourArea(hull);
      if (hullArea > 0.9 * w * h) continue; // background noise

      var fit = tryFitQuadFromHull(hull, epsilons, w, h, bestQuad, bestArea);
      bestQuad = fit.bestQuad; bestArea = fit.bestArea;
    }

    if (bestQuad) break;
  }

  if (!bestQuad) return null;
  var ordered = orderCorners(bestQuad);
  return normalizeQuad(ordered, w, h);
}

function otsuThreshold(gray, w, h) {
  var hist = new Float64Array(256);
  for (var i = 0; i < w * h; i++) {
    var bin = Math.min(255, Math.max(0, Math.round(gray[i])));
    hist[bin]++;
  }
  var total = w * h;
  var sumAll = 0;
  for (var i = 0; i < 256; i++) sumAll += i * hist[i];
  var sumB = 0, wB = 0, bestThresh = 128, bestVar = 0;
  for (var t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    var wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    var mB = sumB / wB;
    var mF = (sumAll - sumB) / wF;
    var between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; bestThresh = t; }
  }
  return bestThresh;
}

function segmentBasedDetection(gray, w, h) {
  // Strong blur to remove text/texture while preserving document outline
  var blurred = gaussianBlur5x5(gray, w, h);
  blurred = gaussianBlur5x5(blurred, w, h);
  blurred = gaussianBlur5x5(blurred, w, h);

  var thresh = otsuThreshold(blurred, w, h);
  var bestQuad = null, bestArea = 0;

  // Try both polarities: light doc on dark bg, and dark doc on light bg
  for (var pol = 0; pol < 2; pol++) {
    var binary = new Uint8Array(w * h);
    for (var i = 0; i < w * h; i++) {
      binary[i] = (pol === 0 ? blurred[i] > thresh : blurred[i] <= thresh) ? 255 : 0;
    }

    // Morphological close (dilate then erode) to fill holes from dark text/barcodes
    var closed = dilateEdgesR(binary, w, h, 3);
    closed = erodeR(closed, w, h, 3);

    var result = labelComponents(closed, w, h);
    var labels = result.labels;
    var comps = result.comps;
    comps.sort(function(a, b) { return b.size - a.size; });

    for (var ci = 0; ci < Math.min(3, comps.length); ci++) {
      var comp = comps[ci];
      if (comp.size < 0.05 * w * h || comp.size > 0.95 * w * h) continue;

      // Collect boundary pixels of this component
      var boundary = [];
      var tgt = comp.label;
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          if (labels[y * w + x] !== tgt) continue;
          var onB = (x === 0 || x === w - 1 || y === 0 || y === h - 1);
          if (!onB) {
            for (var dy = -1; dy <= 1 && !onB; dy++) {
              for (var dx = -1; dx <= 1 && !onB; dx++) {
                if (dx === 0 && dy === 0) continue;
                if (labels[(y + dy) * w + (x + dx)] !== tgt) onB = true;
              }
            }
          }
          if (onB) boundary.push([x, y]);
        }
      }

      if (boundary.length < 20) continue;
      var hull = convexHull(boundary);
      if (hull.length < 4) continue;
      var hullArea = contourArea(hull);
      if (hullArea > 0.9 * w * h || hullArea < 0.05 * w * h) continue;

      var segEpsilons = [0.015, 0.02, 0.03, 0.04, 0.06];
      var fit = tryFitQuadFromHull(hull, segEpsilons, w, h, bestQuad, bestArea);
      bestQuad = fit.bestQuad; bestArea = fit.bestArea;
    }

    if (bestQuad) break;
  }

  if (!bestQuad) return null;
  var ordered = orderCorners(bestQuad);
  return normalizeQuad(ordered, w, h);
}

function houghLines(edges, w, h) {
  var maxRho = Math.ceil(Math.sqrt(w * w + h * h));
  var thetaSteps = 180;
  var rhoSize = maxRho * 2 + 1;
  var acc = new Int32Array(rhoSize * thetaSteps);
  // Precompute sin/cos
  var cosTable = new Float64Array(thetaSteps);
  var sinTable = new Float64Array(thetaSteps);
  for (var t = 0; t < thetaSteps; t++) {
    var theta = (t * Math.PI) / thetaSteps;
    cosTable[t] = Math.cos(theta);
    sinTable[t] = Math.sin(theta);
  }
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      if (edges[y * w + x] === 0) continue;
      for (var t = 0; t < thetaSteps; t++) {
        var rho = Math.round(x * cosTable[t] + y * sinTable[t]) + maxRho;
        acc[rho * thetaSteps + t]++;
      }
    }
  }
  // Find peaks with NMS
  var threshold = Math.max(w, h) * 0.08;
  var lines = [];
  var nmsRadius = 5;
  for (var r = 0; r < rhoSize; r++) {
    for (var t = 0; t < thetaSteps; t++) {
      var votes = acc[r * thetaSteps + t];
      if (votes < threshold) continue;
      var isMax = true;
      for (var dr = -nmsRadius; dr <= nmsRadius && isMax; dr++) {
        for (var dt = -nmsRadius; dt <= nmsRadius && isMax; dt++) {
          if (dr === 0 && dt === 0) continue;
          var nr = r + dr, nt = t + dt;
          if (nr < 0 || nr >= rhoSize || nt < 0 || nt >= thetaSteps) continue;
          if (acc[nr * thetaSteps + nt] > votes) isMax = false;
        }
      }
      if (isMax) {
        lines.push({ rho: r - maxRho, theta: (t * Math.PI) / thetaSteps, votes: votes });
      }
    }
  }
  lines.sort(function(a, b) { return b.votes - a.votes; });
  return lines;
}

function lineIntersection(l1, l2) {
  var cos1 = Math.cos(l1.theta), sin1 = Math.sin(l1.theta);
  var cos2 = Math.cos(l2.theta), sin2 = Math.sin(l2.theta);
  var det = cos1 * sin2 - cos2 * sin1;
  if (Math.abs(det) < 1e-10) return null;
  var x = (l1.rho * sin2 - l2.rho * sin1) / det;
  var y = (l2.rho * cos1 - l1.rho * cos2) / det;
  return [x, y];
}

function findBestQuad(lines, w, h) {
  if (lines.length < 4) return null;
  // Classify lines with overlapping angle ranges to support ~30° tilted documents
  var horizontal = [], vertical = [];
  for (var i = 0; i < lines.length; i++) {
    var deg = (lines[i].theta * 180) / Math.PI;
    if (deg > 30 && deg < 150) {
      horizontal.push(lines[i]);
    }
    if (deg < 60 || deg > 120) {
      vertical.push(lines[i]);
    }
  }
  if (horizontal.length < 2 || vertical.length < 2) return null;
  horizontal = horizontal.slice(0, 8);
  vertical = vertical.slice(0, 8);
  // Score line pairs: combine vote strength and spread
  var maxSpreadH = 0;
  for (var i = 0; i < horizontal.length; i++) {
    for (var j = i + 1; j < horizontal.length; j++) {
      var sinI = Math.sin(horizontal[i].theta);
      var sinJ = Math.sin(horizontal[j].theta);
      if (Math.abs(sinI) < 1e-6 || Math.abs(sinJ) < 1e-6) continue;
      var y1 = horizontal[i].rho / sinI;
      var y2 = horizontal[j].rho / sinJ;
      var d = Math.abs(y1 - y2);
      if (d > maxSpreadH) maxSpreadH = d;
    }
  }
  var bestH = null, bestHScore = 0;
  for (var i = 0; i < horizontal.length; i++) {
    for (var j = i + 1; j < horizontal.length; j++) {
      var sinI = Math.sin(horizontal[i].theta);
      var sinJ = Math.sin(horizontal[j].theta);
      if (Math.abs(sinI) < 1e-6 || Math.abs(sinJ) < 1e-6) continue;
      var y1 = horizontal[i].rho / sinI;
      var y2 = horizontal[j].rho / sinJ;
      var spread = Math.abs(y1 - y2);
      var score = (horizontal[i].votes + horizontal[j].votes) * (0.6 + 0.4 * spread / (maxSpreadH || 1));
      if (score > bestHScore) {
        bestHScore = score;
        bestH = y1 < y2 ? [horizontal[i], horizontal[j]] : [horizontal[j], horizontal[i]];
      }
    }
  }
  var maxSpreadV = 0;
  for (var i = 0; i < vertical.length; i++) {
    for (var j = i + 1; j < vertical.length; j++) {
      var cosI = Math.cos(vertical[i].theta);
      var cosJ = Math.cos(vertical[j].theta);
      if (Math.abs(cosI) < 1e-6 || Math.abs(cosJ) < 1e-6) continue;
      var x1 = vertical[i].rho / cosI;
      var x2 = vertical[j].rho / cosJ;
      var d = Math.abs(x1 - x2);
      if (d > maxSpreadV) maxSpreadV = d;
    }
  }
  var bestV = null, bestVScore = 0;
  for (var i = 0; i < vertical.length; i++) {
    for (var j = i + 1; j < vertical.length; j++) {
      var cosI = Math.cos(vertical[i].theta);
      var cosJ = Math.cos(vertical[j].theta);
      if (Math.abs(cosI) < 1e-6 || Math.abs(cosJ) < 1e-6) continue;
      var x1 = vertical[i].rho / cosI;
      var x2 = vertical[j].rho / cosJ;
      var spread = Math.abs(x1 - x2);
      var score = (vertical[i].votes + vertical[j].votes) * (0.6 + 0.4 * spread / (maxSpreadV || 1));
      if (score > bestVScore) {
        bestVScore = score;
        bestV = x1 < x2 ? [vertical[i], vertical[j]] : [vertical[j], vertical[i]];
      }
    }
  }
  if (!bestH || !bestV) return null;
  var topLine = bestH[0], bottomLine = bestH[1];
  var leftLine = bestV[0], rightLine = bestV[1];
  // Compute 4 intersection points
  var tl = lineIntersection(topLine, leftLine);
  var tr = lineIntersection(topLine, rightLine);
  var br = lineIntersection(bottomLine, rightLine);
  var bl = lineIntersection(bottomLine, leftLine);
  if (!tl || !tr || !br || !bl) return null;
  // Validate: all points should be within reasonable range
  var margin = -0.1 * Math.max(w, h);
  var limit = 1.1 * Math.max(w, h);
  var pts = [tl, tr, br, bl];
  for (var i = 0; i < 4; i++) {
    if (pts[i][0] < margin || pts[i][0] > limit || pts[i][1] < margin || pts[i][1] > limit) {
      return null;
    }
  }
  // Validate: quadrilateral area > 10% of image area
  var quadArea = 0.5 * Math.abs(
    (tr[0]-tl[0])*(bl[1]-tl[1]) - (bl[0]-tl[0])*(tr[1]-tl[1]) +
    (br[0]-tr[0])*(tl[1]-tr[1]) - (tl[0]-tr[0])*(br[1]-tr[1]) +
    (bl[0]-br[0])*(tr[1]-br[1]) - (tr[0]-br[0])*(bl[1]-br[1]) +
    (tl[0]-bl[0])*(br[1]-bl[1]) - (br[0]-bl[0])*(tl[1]-bl[1])
  );
  if (quadArea < 0.1 * w * h) return null;
  // Normalize to 0-1
  return normalizeQuad([tl, tr, br, bl], w, h);
}

function ransacLine(points, maxIter, distThresh) {
  var n = points.length;
  if (n < 2) return null;
  var bestScore = 0, bestA = 0, bestB = 0, bestC = 0;
  for (var iter = 0; iter < maxIter; iter++) {
    var i1 = Math.floor(Math.random() * n);
    var i2 = Math.floor(Math.random() * (n - 1));
    if (i2 >= i1) i2++;
    var x1 = points[i1][0], y1 = points[i1][1];
    var x2 = points[i2][0], y2 = points[i2][1];
    var la = y2 - y1, lb = x1 - x2;
    var lc = x2 * y1 - x1 * y2;
    var norm = Math.sqrt(la * la + lb * lb);
    if (norm < 1e-10) continue;
    la /= norm; lb /= norm; lc /= norm;
    var cnt = 0, minP = 1e9, maxP = -1e9;
    for (var j = 0; j < n; j++) {
      if (Math.abs(la * points[j][0] + lb * points[j][1] + lc) < distThresh) {
        cnt++;
        var p = -lb * points[j][0] + la * points[j][1];
        if (p < minP) minP = p;
        if (p > maxP) maxP = p;
      }
    }
    if (cnt < 5) continue;
    var sc = cnt * (maxP - minP);
    if (sc > bestScore) { bestScore = sc; bestA = la; bestB = lb; bestC = lc; }
  }
  if (bestScore === 0) return null;
  var mask = new Uint8Array(n);
  var total = 0, cx = 0, cy = 0;
  for (var j = 0; j < n; j++) {
    if (Math.abs(bestA * points[j][0] + bestB * points[j][1] + bestC) < distThresh) {
      mask[j] = 1; total++; cx += points[j][0]; cy += points[j][1];
    }
  }
  if (total > 0) { cx /= total; cy /= total; }
  return { a: bestA, b: bestB, c: bestC, count: total, score: bestScore, inlierMask: mask, cx: cx, cy: cy };
}

function intersectLineEq(l1, l2) {
  var det = l1.a * l2.b - l2.a * l1.b;
  if (Math.abs(det) < 1e-10) return null;
  return [(l1.b * l2.c - l2.b * l1.c) / det, (l2.a * l1.c - l1.a * l2.c) / det];
}

function gradientRansacDetection(gray, w, h) {
  var blurred = gaussianBlur5x5(gaussianBlur5x5(gray, w, h), w, h);
  var grad = sobelGradients(blurred, w, h);
  var nms = nonMaxSuppression(grad.mag, grad.dir, w, h);
  var allMags = [];
  for (var i = 0; i < w * h; i++) {
    if (nms[i] > 0) allMags.push(nms[i]);
  }
  if (allMags.length < 50) return null;
  allMags.sort(function(a, b) { return b - a; });

  var threshFracs = [0.10, 0.20, 0.35];
  for (var ti = 0; ti < threshFracs.length; ti++) {
    var magTh = allMags[Math.min(Math.floor(allMags.length * threshFracs[ti]), allMags.length - 1)];
    var pixels = [];
    for (var py = 1; py < h - 1; py++) {
      for (var px = 1; px < w - 1; px++) {
        if (nms[py * w + px] < magTh) continue;
        var gd = grad.dir[py * w + px];
        if (gd < 0) gd += Math.PI;
        var bin = Math.floor(gd * 180 / Math.PI);
        if (bin >= 180) bin = 179;
        if (bin < 0) bin = 0;
        pixels.push([px, py, bin]);
      }
    }
    if (pixels.length < 50) continue;

    // Direction histogram (1-degree bins)
    var dirH = new Float64Array(180);
    for (var i = 0; i < pixels.length; i++) dirH[pixels[i][2]]++;
    // Smooth with radius 5 (circular)
    var sm = new Float64Array(180);
    for (var i = 0; i < 180; i++) {
      for (var j = -5; j <= 5; j++) sm[i] += dirH[((i + j) % 180 + 180) % 180];
    }

    // Find dominant direction peak1
    var pk1 = 0;
    for (var i = 1; i < 180; i++) { if (sm[i] > sm[pk1]) pk1 = i; }

    // Find peak2: should be ~90 deg from peak1 (search 60-120 deg offset)
    var pk2 = -1, pk2V = -1;
    for (var off = 60; off <= 120; off++) {
      var idx = (pk1 + off) % 180;
      if (sm[idx] > pk2V) { pk2V = sm[idx]; pk2 = idx; }
    }
    if (pk2 === -1 || pk2V < sm[pk1] * 0.05) continue;

    // Group pixels by gradient direction (tolerance +-25 deg)
    var tol = 25;
    var g1 = [], g2 = [];
    for (var i = 0; i < pixels.length; i++) {
      var pb = pixels[i][2];
      var d1 = Math.abs(pb - pk1); if (d1 > 90) d1 = 180 - d1;
      var d2 = Math.abs(pb - pk2); if (d2 > 90) d2 = 180 - d2;
      if (d1 <= tol) g1.push([pixels[i][0], pixels[i][1]]);
      else if (d2 <= tol) g2.push([pixels[i][0], pixels[i][1]]);
    }
    if (g1.length < 20 || g2.length < 20) continue;

    var dThr = Math.max(2, Math.min(w, h) * 0.006);
    var groups = [g1, g2];
    var pairs = [null, null];
    var pairsOk = true;

    for (var gi = 0; gi < 2; gi++) {
      var grp = groups[gi];
      // Find up to 5 lines by iterative RANSAC
      var lines = [];
      var rem = grp.slice();
      for (var li = 0; li < 5 && rem.length > 10; li++) {
        var ln = ransacLine(rem, 1200, dThr);
        if (!ln || ln.count < 5) break;
        lines.push(ln);
        var newRem = [];
        for (var ri = 0; ri < rem.length; ri++) {
          if (!ln.inlierMask[ri]) newRem.push(rem[ri]);
        }
        rem = newRem;
      }
      if (lines.length < 2) { pairsOk = false; break; }
      // Select widest-separated pair (distance from one line to other's centroid)
      var bestSep = 0, bestPair = null;
      for (var i = 0; i < lines.length; i++) {
        for (var j = i + 1; j < lines.length; j++) {
          var sep = Math.abs(lines[i].a * lines[j].cx + lines[i].b * lines[j].cy + lines[i].c);
          if (sep > bestSep) { bestSep = sep; bestPair = [lines[i], lines[j]]; }
        }
      }
      if (!bestPair || bestSep < Math.min(w, h) * 0.10) { pairsOk = false; break; }
      pairs[gi] = bestPair;
    }
    if (!pairsOk) continue;

    // Intersect: pairs[0] x pairs[1] -> 4 corners
    var corners = [];
    var allOk = true;
    for (var i = 0; i < 2 && allOk; i++) {
      for (var j = 0; j < 2 && allOk; j++) {
        var pt = intersectLineEq(pairs[0][i], pairs[1][j]);
        if (!pt) { allOk = false; } else { corners.push(pt); }
      }
    }
    if (!allOk || corners.length !== 4) continue;

    var margin = Math.max(w, h) * 0.15;
    var inBounds = true;
    for (var i = 0; i < 4; i++) {
      if (corners[i][0] < -margin || corners[i][0] > w + margin ||
          corners[i][1] < -margin || corners[i][1] > h + margin) {
        inBounds = false; break;
      }
    }
    if (!inBounds) continue;

    var ordered = orderCorners(corners);
    if (!validateQuad(ordered, w, h)) continue;

    return normalizeQuad(ordered, w, h);
  }
  return null;
}

function detectDocument(base64) {
  return new Promise(function(resolve) {
    var img = new Image();
    img.onload = function() {
      try {
        var ow = img.width, oh = img.height;
        // Scale down to ~500px long side
        var maxSide = 500;
        var scale = 1;
        if (Math.max(ow, oh) > maxSide) {
          scale = maxSide / Math.max(ow, oh);
        }
        var w = Math.round(ow * scale);
        var h = Math.round(oh * scale);
        var canvas = document.getElementById('src');
        canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        var data = ctx.getImageData(0, 0, w, h).data;
        var gray = toGray(data, w, h);
        // Primary: gradient-direction RANSAC (robust for tilted documents)
        var quad = gradientRansacDetection(gray, w, h);
        if (!quad) {
          // Secondary: brightness segmentation
          quad = segmentBasedDetection(gray, w, h);
        }
        if (!quad) {
          var edges = cannyEdges(gray, w, h);
          // Tertiary: edge-based contour + hull detection
          quad = contourBasedDetection(edges, w, h);
          if (!quad) {
            // Quaternary: Hough line detection
            var lines = houghLines(edges, w, h);
            quad = findBestQuad(lines, w, h);
          }
        }
        resolve(quad);
      } catch (e) {
        resolve(null);
      }
    };
    img.onerror = function() { resolve(null); };
    img.src = 'data:image/jpeg;base64,' + base64;
  });
}

function decodeBase64Image(base64) {
  var binary = atob(base64);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  var blob = new Blob([bytes], { type: 'image/jpeg' });
  // First create at full size to get dimensions, then resize if needed
  return createImageBitmap(blob).then(function(fullBmp) {
    var maxDim = 1600;
    if (fullBmp.width <= maxDim && fullBmp.height <= maxDim) return fullBmp;
    var scale = maxDim / Math.max(fullBmp.width, fullBmp.height);
    var nw = Math.round(fullBmp.width * scale);
    var nh = Math.round(fullBmp.height * scale);
    fullBmp.close();
    return createImageBitmap(blob, { resizeWidth: nw, resizeHeight: nh, resizeQuality: 'high' });
  });
}

// ── Main process handler ──
function processImage(base64, corners, mode) {
  return decodeBase64Image(base64).then(function(bmp) {
    var sw = bmp.width, sh = bmp.height;

    var srcCanvas = document.getElementById('src');
    srcCanvas.width = sw; srcCanvas.height = sh;
    var srcCtx = srcCanvas.getContext('2d');
    srcCtx.drawImage(bmp, 0, 0);
    bmp.close();
    var srcData = srcCtx.getImageData(0, 0, sw, sh).data;

    var tl = [corners.tl.x*sw, corners.tl.y*sh];
    var tr = [corners.tr.x*sw, corners.tr.y*sh];
    var br = [corners.br.x*sw, corners.br.y*sh];
    var bl = [corners.bl.x*sw, corners.bl.y*sh];

    var dw = Math.round(Math.max(dist(tl,tr), dist(bl,br)));
    var dh = Math.round(Math.max(dist(tl,bl), dist(tr,br)));
    dw = Math.max(dw, 100);
    dh = Math.max(dh, 100);
    var maxDim = 2000;
    if (dw > maxDim || dh > maxDim) {
      var dimScale = maxDim / Math.max(dw, dh);
      dw = Math.round(dw * dimScale);
      dh = Math.round(dh * dimScale);
    }

    var srcPts = [tl, tr, br, bl];
    var dstPts = [[0,0],[dw,0],[dw,dh],[0,dh]];
    var H = computeHomography(srcPts, dstPts);
    if (!H) throw new Error('Failed to compute homography');
    var H_inv = invert3x3(H);
    if (!H_inv) throw new Error('Failed to invert homography');

    var warped = warp(srcData, sw, sh, H_inv, dw, dh);

    if (mode === 'bw') enhanceBW(warped, dw, dh);
    else if (mode === 'gray') enhanceGray(warped, dw, dh);
    else enhanceColor(warped, dw, dh);

    // Fill out-of-bounds pixels with white and ensure all alpha=255 for JPEG
    for (var fi = 0; fi < dw*dh; fi++) {
      if (warped[fi*4+3] === 0) {
        warped[fi*4] = warped[fi*4+1] = warped[fi*4+2] = 255;
      }
      warped[fi*4+3] = 255;
    }

    var dstCanvas = document.getElementById('dst');
    dstCanvas.width = dw; dstCanvas.height = dh;
    var dstCtx = dstCanvas.getContext('2d');
    var imgData = dstCtx.createImageData(dw, dh);
    imgData.data.set(warped);
    dstCtx.putImageData(imgData, 0, 0);

    var resultB64 = dstCanvas.toDataURL('image/jpeg', 0.92).split(',')[1];
    return { base64: resultB64, width: dw, height: dh, srcWidth: sw, srcHeight: sh };
  });
}

// ── Preview filters (generate 3 thumbnails) ──
function previewFilters(base64, corners) {
  return decodeBase64Image(base64).then(function(bmp) {
    var ow = bmp.width, oh = bmp.height;
    // Scale to ~500px long side for fast processing
    var maxSide = 500;
    var scale = 1;
    if (Math.max(ow, oh) > maxSide) {
      scale = maxSide / Math.max(ow, oh);
    }
    var sw = Math.round(ow * scale);
    var sh = Math.round(oh * scale);
    var srcCanvas = document.getElementById('src');
    srcCanvas.width = sw; srcCanvas.height = sh;
    var srcCtx = srcCanvas.getContext('2d');
    srcCtx.drawImage(bmp, 0, 0, sw, sh);
    bmp.close();
    var srcData = srcCtx.getImageData(0, 0, sw, sh).data;

    var tl = [corners.tl.x * sw, corners.tl.y * sh];
    var tr = [corners.tr.x * sw, corners.tr.y * sh];
    var br = [corners.br.x * sw, corners.br.y * sh];
    var bl = [corners.bl.x * sw, corners.bl.y * sh];

    var dw = Math.round(Math.max(dist(tl, tr), dist(bl, br)));
    var dh = Math.round(Math.max(dist(tl, bl), dist(tr, br)));
    dw = Math.max(dw, 50);
    dh = Math.max(dh, 50);

    var srcPts = [tl, tr, br, bl];
    var dstPts = [[0, 0], [dw, 0], [dw, dh], [0, dh]];
    var H = computeHomography(srcPts, dstPts);
    if (!H) throw new Error('Failed to compute homography');
    var H_inv = invert3x3(H);
    if (!H_inv) throw new Error('Failed to invert homography');

    var warped = warp(srcData, sw, sh, H_inv, dw, dh);

    var dstCanvas = document.getElementById('dst');
    dstCanvas.width = dw; dstCanvas.height = dh;
    var dstCtx = dstCanvas.getContext('2d');

    var modes = ['bw', 'gray', 'color'];
    var results = {};
    for (var mi = 0; mi < modes.length; mi++) {
      var copy = new Uint8ClampedArray(warped);
      if (modes[mi] === 'bw') enhanceBW(copy, dw, dh);
      else if (modes[mi] === 'gray') enhanceGray(copy, dw, dh);
      else enhanceColor(copy, dw, dh);
      var imgData = dstCtx.createImageData(dw, dh);
      imgData.data.set(copy);
      dstCtx.putImageData(imgData, 0, 0);
      results[modes[mi]] = dstCanvas.toDataURL('image/jpeg', 0.7).split(',')[1];
    }
    return results;
  });
}

// ── Input chunk assembly (called via injectJavaScript) ──
var processChunks = [];
var processChunkTotal = 0;

function receiveProcessChunk(index, total, data) {
  processChunkTotal = total;
  if (index === 0) processChunks = new Array(total);
  processChunks[index] = data;
}

function startProcess(corners, mode) {
  var b64 = processChunks.join('');
  processChunks = [];
  processChunkTotal = 0;

  function sendResult(result) {
    var rb64 = result.base64;
    var CHUNK = 512000;
    if (rb64.length > CHUNK) {
      var total = Math.ceil(rb64.length / CHUNK);
      for (var ri = 0; ri < total; ri++) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'resultChunk', index: ri, total: total,
          data: rb64.substr(ri * CHUNK, CHUNK),
          width: result.width, height: result.height,
          srcWidth: result.srcWidth, srcHeight: result.srcHeight
        }));
      }
    } else {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'result', base64: rb64,
        width: result.width, height: result.height,
        srcWidth: result.srcWidth, srcHeight: result.srcHeight
      }));
    }
  }

  processImage(b64, corners, mode)
    .then(sendResult)
    .catch(function(err) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'error', context: 'process',
        message: err.message || 'Processing failed'
      }));
    });
}

// ── Message handler ──
window.addEventListener('message', function(e) {
  try {
    var msg = JSON.parse(e.data);
    if (msg.type === 'process') {
      processImage(msg.base64, msg.corners, msg.mode)
        .then(function(result) {
          var b64 = result.base64;
          var CHUNK = 512000;
          if (b64.length > CHUNK) {
            var total = Math.ceil(b64.length / CHUNK);
            for (var ci = 0; ci < total; ci++) {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'resultChunk',
                index: ci,
                total: total,
                data: b64.substr(ci * CHUNK, CHUNK),
                width: result.width,
                height: result.height,
                srcWidth: result.srcWidth,
                srcHeight: result.srcHeight
              }));
            }
          } else {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'result',
              base64: b64,
              width: result.width,
              height: result.height,
              srcWidth: result.srcWidth,
              srcHeight: result.srcHeight
            }));
          }
        })
        .catch(function(err) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'error',
            context: 'process',
            message: err.message || 'Processing failed'
          }));
        });
    } else if (msg.type === 'detect') {
      detectDocument(msg.base64)
        .then(function(corners) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'corners',
            corners: corners
          }));
        })
        .catch(function() {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'corners',
            corners: null
          }));
        });
    } else if (msg.type === 'previewFilters') {
      previewFilters(msg.base64, msg.corners)
        .then(function(previews) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'filterPreviews',
            bw: previews.bw,
            gray: previews.gray,
            color: previews.color
          }));
        })
        .catch(function(err) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'error',
            context: 'previewFilters',
            message: err.message || 'Preview generation failed'
          }));
        });
    }
  } catch (err) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'error',
      message: 'Invalid message: ' + err.message
    }));
  }
});

// Also listen on document for Android
document.addEventListener('message', function(e) {
  window.dispatchEvent(new MessageEvent('message', { data: e.data }));
});

window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));
</script>
</body></html>`;
}
