/**
 * Generates the HTML/JS that runs inside a WebView to perform
 * perspective correction and image enhancement entirely on the client.
 *
 * Communication protocol (postMessage JSON):
 *   RN -> WebView: { type:'process', base64, corners: {tl,tr,br,bl}, mode: 'bw'|'gray'|'color' }
 *   WebView -> RN: { type:'result', base64, width, height }
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
  var M = [];
  for (var i = 0; i < n; i++) {
    M[i] = A[i].slice();
    M[i].push(b[i]);
  }
  for (var col = 0; col < n; col++) {
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

// ── Compute 3x3 homography mapping src quad -> dst rect (DLT) ──
function computeHomography(srcPts, dstPts) {
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
  return [h[0],h[1],h[2],h[3],h[4],h[5],h[6],h[7],1];
}

// ── Invert 3x3 matrix ──
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

// ── Bilinear interpolation on source imageData ──
function bilinear(srcData, sw, sh, x, y) {
  var x0 = Math.floor(x), y0 = Math.floor(y);
  var x1 = Math.min(x0+1, sw-1), y1 = Math.min(y0+1, sh-1);
  x0 = Math.max(0, x0); y0 = Math.max(0, y0);
  var fx = x - Math.floor(x), fy = y - Math.floor(y);
  var idx00 = (y0*sw+x0)*4, idx10 = (y0*sw+x1)*4;
  var idx01 = (y1*sw+x0)*4, idx11 = (y1*sw+x1)*4;
  var r = [], s = srcData;
  for (var c = 0; c < 3; c++) {
    var v = s[idx00+c]*(1-fx)*(1-fy) + s[idx10+c]*fx*(1-fy)
          + s[idx01+c]*(1-fx)*fy + s[idx11+c]*fx*fy;
    r.push(v);
  }
  return r;
}

// ── Perspective warp (inverse mapping) ──
function warp(srcData, sw, sh, H_inv, dw, dh) {
  var out = new Uint8ClampedArray(dw * dh * 4);
  for (var dy = 0; dy < dh; dy++) {
    for (var dx = 0; dx < dw; dx++) {
      var w = H_inv[6]*dx + H_inv[7]*dy + H_inv[8];
      var sx = (H_inv[0]*dx + H_inv[1]*dy + H_inv[2]) / w;
      var sy = (H_inv[3]*dx + H_inv[4]*dy + H_inv[5]) / w;
      var idx = (dy*dw+dx)*4;
      if (sx >= 0 && sx < sw && sy >= 0 && sy < sh) {
        var rgb = bilinear(srcData, sw, sh, sx, sy);
        out[idx]   = rgb[0];
        out[idx+1] = rgb[1];
        out[idx+2] = rgb[2];
      }
      out[idx+3] = 255;
    }
  }
  return out;
}

// ── Adaptive threshold (integral image) ──
function adaptiveThreshold(gray, w, h, blockSize, C) {
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
  var gray = new Float64Array(w*h);
  for (var i = 0; i < w*h; i++) {
    gray[i] = 0.299*data[i*4] + 0.587*data[i*4+1] + 0.114*data[i*4+2];
  }
  return gray;
}

// ── Enhancement modes ──
function enhanceBW(data, w, h) {
  var gray = toGray(data, w, h);
  var blockSize = Math.max(15, Math.round(Math.min(w,h)/8)|1);
  if (blockSize % 2 === 0) blockSize++;
  var bw = adaptiveThreshold(gray, w, h, blockSize, 10);
  for (var i = 0; i < w*h; i++) {
    data[i*4] = data[i*4+1] = data[i*4+2] = bw[i];
  }
}

function enhanceGray(data, w, h) {
  var gray = toGray(data, w, h);
  var sorted = Array.from(gray).sort(function(a,b){return a-b;});
  var lo = sorted[Math.floor(sorted.length*0.01)];
  var hi = sorted[Math.floor(sorted.length*0.99)];
  var range = hi - lo || 1;
  for (var i = 0; i < w*h; i++) {
    var v = Math.round(((gray[i]-lo)/range)*255);
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    data[i*4] = data[i*4+1] = data[i*4+2] = v;
  }
}

function enhanceColor(data, w, h) {
  var n = w * h;
  for (var c = 0; c < 3; c++) {
    var ch = new Float64Array(n);
    for (var i = 0; i < n; i++) ch[i] = data[i*4+c];
    var sorted = Array.from(ch).sort(function(a,b){return a-b;});
    var lo = sorted[Math.floor(n*0.01)];
    var hi = sorted[Math.floor(n*0.99)];
    var range = hi - lo || 1;
    for (var i = 0; i < n; i++) {
      var v = ((ch[i]-lo)/range)*255;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      v = Math.round(Math.pow(v/255, 0.85)*255);
      data[i*4+c] = v;
    }
  }
}

// ── Main process handler ──
function processImage(base64, corners, mode) {
  return new Promise(function(resolve, reject) {
    var img = new Image();
    img.onload = function() {
      try {
        var sw = img.width, sh = img.height;
        var srcCanvas = document.getElementById('src');
        srcCanvas.width = sw; srcCanvas.height = sh;
        var srcCtx = srcCanvas.getContext('2d');
        srcCtx.drawImage(img, 0, 0);
        var srcData = srcCtx.getImageData(0, 0, sw, sh).data;

        var tl = [corners.tl.x*sw, corners.tl.y*sh];
        var tr = [corners.tr.x*sw, corners.tr.y*sh];
        var br = [corners.br.x*sw, corners.br.y*sh];
        var bl = [corners.bl.x*sw, corners.bl.y*sh];

        var dw = Math.round(Math.max(dist(tl,tr), dist(bl,br)));
        var dh = Math.round(Math.max(dist(tl,bl), dist(tr,br)));
        dw = Math.max(dw, 100);
        dh = Math.max(dh, 100);

        var maxDim = 3000;
        if (dw > maxDim || dh > maxDim) {
          var scale = maxDim / Math.max(dw, dh);
          dw = Math.round(dw * scale);
          dh = Math.round(dh * scale);
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

        var dstCanvas = document.getElementById('dst');
        dstCanvas.width = dw; dstCanvas.height = dh;
        var dstCtx = dstCanvas.getContext('2d');
        var imgData = dstCtx.createImageData(dw, dh);
        imgData.data.set(warped);
        dstCtx.putImageData(imgData, 0, 0);

        var resultB64 = dstCanvas.toDataURL('image/png').split(',')[1];
        resolve({ base64: resultB64, width: dw, height: dh });
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = function() { reject(new Error('Failed to load image')); };
    img.src = 'data:image/jpeg;base64,' + base64;
  });
}

// ── Message handler ──
window.addEventListener('message', function(e) {
  try {
    var msg = JSON.parse(e.data);
    if (msg.type === 'process') {
      processImage(msg.base64, msg.corners, msg.mode)
        .then(function(result) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'result',
            base64: result.base64,
            width: result.width,
            height: result.height
          }));
        })
        .catch(function(err) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'error',
            message: err.message || 'Processing failed'
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

document.addEventListener('message', function(e) {
  window.dispatchEvent(new MessageEvent('message', { data: e.data }));
});

window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));
</script>
</body></html>`;
}
