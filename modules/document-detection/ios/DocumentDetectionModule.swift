import ExpoModulesCore
import Vision
import UIKit

public class DocumentDetectionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DocumentDetection")

    // Native perspective correction using Core Image — handles full-res images
    AsyncFunction("processImageNative") { (base64: String, corners: [String: [String: Double]], mode: String) -> [String: Any] in
      guard let data = Data(base64Encoded: base64),
            let uiImage = UIImage(data: data),
            let cgImage = uiImage.cgImage else {
        throw NSError(domain: "DocumentDetection", code: 2,
                      userInfo: [NSLocalizedDescriptionKey: "Could not decode image"])
      }

      // Apply EXIF orientation so CIImage extent matches displayed dimensions
      let rawCI = CIImage(cgImage: cgImage)
      var ciImage: CIImage
      switch uiImage.imageOrientation {
      case .up:            ciImage = rawCI
      case .down:          ciImage = rawCI.oriented(.down)
      case .left:          ciImage = rawCI.oriented(.left)
      case .right:         ciImage = rawCI.oriented(.right)
      case .upMirrored:    ciImage = rawCI.oriented(.upMirrored)
      case .downMirrored:  ciImage = rawCI.oriented(.downMirrored)
      case .leftMirrored:  ciImage = rawCI.oriented(.leftMirrored)
      case .rightMirrored: ciImage = rawCI.oriented(.rightMirrored)
      @unknown default:    ciImage = rawCI
      }

      // After orientation, extent origin might not be (0,0) — translate back
      if ciImage.extent.origin != .zero {
        ciImage = ciImage.transformed(by: CGAffineTransform(translationX: -ciImage.extent.origin.x, y: -ciImage.extent.origin.y))
      }

      let w = ciImage.extent.width
      let h = ciImage.extent.height

      // Convert normalized corners to CIImage coordinates (origin bottom-left)
      guard let tl = corners["tl"], let tr = corners["tr"],
            let br = corners["br"], let bl = corners["bl"] else {
        throw NSError(domain: "DocumentDetection", code: 3,
                      userInfo: [NSLocalizedDescriptionKey: "Invalid corners"])
      }

      let topLeft = CIVector(x: CGFloat(tl["x"]!) * w, y: (1 - CGFloat(tl["y"]!)) * h)
      let topRight = CIVector(x: CGFloat(tr["x"]!) * w, y: (1 - CGFloat(tr["y"]!)) * h)
      let bottomRight = CIVector(x: CGFloat(br["x"]!) * w, y: (1 - CGFloat(br["y"]!)) * h)
      let bottomLeft = CIVector(x: CGFloat(bl["x"]!) * w, y: (1 - CGFloat(bl["y"]!)) * h)

      guard let filter = CIFilter(name: "CIPerspectiveCorrection") else {
        throw NSError(domain: "DocumentDetection", code: 4,
                      userInfo: [NSLocalizedDescriptionKey: "CIPerspectiveCorrection not available"])
      }

      filter.setValue(ciImage, forKey: kCIInputImageKey)
      filter.setValue(topLeft, forKey: "inputTopLeft")
      filter.setValue(topRight, forKey: "inputTopRight")
      filter.setValue(bottomRight, forKey: "inputBottomRight")
      filter.setValue(bottomLeft, forKey: "inputBottomLeft")

      guard var outputImage = filter.outputImage else {
        throw NSError(domain: "DocumentDetection", code: 5,
                      userInfo: [NSLocalizedDescriptionKey: "Perspective correction failed"])
      }

      // Apply enhancement based on mode
      if mode == "gray" {
        if let grayFilter = CIFilter(name: "CIPhotoEffectMono") {
          grayFilter.setValue(outputImage, forKey: kCIInputImageKey)
          if let result = grayFilter.outputImage { outputImage = result }
        }
        // Increase contrast for document clarity
        if let contrastFilter = CIFilter(name: "CIColorControls") {
          contrastFilter.setValue(outputImage, forKey: kCIInputImageKey)
          contrastFilter.setValue(1.3, forKey: kCIInputContrastKey)
          contrastFilter.setValue(0.05, forKey: kCIInputBrightnessKey)
          if let result = contrastFilter.outputImage { outputImage = result }
        }
      } else if mode == "bw" {
        if let grayFilter = CIFilter(name: "CIPhotoEffectMono") {
          grayFilter.setValue(outputImage, forKey: kCIInputImageKey)
          if let result = grayFilter.outputImage { outputImage = result }
        }
        // High contrast for B&W document look
        if let contrastFilter = CIFilter(name: "CIColorControls") {
          contrastFilter.setValue(outputImage, forKey: kCIInputImageKey)
          contrastFilter.setValue(2.0, forKey: kCIInputContrastKey)
          contrastFilter.setValue(0.1, forKey: kCIInputBrightnessKey)
          if let result = contrastFilter.outputImage { outputImage = result }
        }
      } else {
        // "color" mode — subtle enhancement
        if let contrastFilter = CIFilter(name: "CIColorControls") {
          contrastFilter.setValue(outputImage, forKey: kCIInputImageKey)
          contrastFilter.setValue(1.1, forKey: kCIInputContrastKey)
          contrastFilter.setValue(1.05, forKey: kCIInputSaturationKey)
          if let result = contrastFilter.outputImage { outputImage = result }
        }
      }

      // Keep high quality — editor is now native too
      let maxOutputDim: CGFloat = 4000
      let extent = outputImage.extent
      if extent.width > maxOutputDim || extent.height > maxOutputDim {
        let scale = maxOutputDim / max(extent.width, extent.height)
        if let scaleFilter = CIFilter(name: "CILanczosScaleTransform") {
          scaleFilter.setValue(outputImage, forKey: kCIInputImageKey)
          scaleFilter.setValue(scale, forKey: kCIInputScaleKey)
          scaleFilter.setValue(1.0, forKey: kCIInputAspectRatioKey)
          if let scaled = scaleFilter.outputImage { outputImage = scaled }
        }
      }

      let context = CIContext(options: [.useSoftwareRenderer: false])
      let finalExtent = outputImage.extent
      guard let cgResult = context.createCGImage(outputImage, from: finalExtent) else {
        throw NSError(domain: "DocumentDetection", code: 6,
                      userInfo: [NSLocalizedDescriptionKey: "Failed to render result"])
      }

      let resultImage = UIImage(cgImage: cgResult)
      guard let jpegData = resultImage.jpegData(compressionQuality: 0.92) else {
        throw NSError(domain: "DocumentDetection", code: 7,
                      userInfo: [NSLocalizedDescriptionKey: "Failed to encode JPEG"])
      }

      let resultBase64 = jpegData.base64EncodedString()
      return [
        "base64": resultBase64,
        "width": Int(finalExtent.width),
        "height": Int(finalExtent.height)
      ]
    }

    // Native image editing — rotation, brightness, contrast, saturation, warmth, sepia, grayscale
    AsyncFunction("applyEditsNative") { (base64: String, rotation: Int, brightness: Double, contrast: Double, saturation: Double, warmth: Double, sepia: Double, grayscale: Double) -> [String: Any] in
      guard let data = Data(base64Encoded: base64),
            let uiImage = UIImage(data: data),
            let cgImage = uiImage.cgImage else {
        throw NSError(domain: "DocumentDetection", code: 10,
                      userInfo: [NSLocalizedDescriptionKey: "Could not decode image"])
      }

      // Apply orientation
      let rawCI = CIImage(cgImage: cgImage)
      var ciImage: CIImage
      switch uiImage.imageOrientation {
      case .up:            ciImage = rawCI
      case .down:          ciImage = rawCI.oriented(.down)
      case .left:          ciImage = rawCI.oriented(.left)
      case .right:         ciImage = rawCI.oriented(.right)
      case .upMirrored:    ciImage = rawCI.oriented(.upMirrored)
      case .downMirrored:  ciImage = rawCI.oriented(.downMirrored)
      case .leftMirrored:  ciImage = rawCI.oriented(.leftMirrored)
      case .rightMirrored: ciImage = rawCI.oriented(.rightMirrored)
      @unknown default:    ciImage = rawCI
      }

      if ciImage.extent.origin != .zero {
        ciImage = ciImage.transformed(by: CGAffineTransform(translationX: -ciImage.extent.origin.x, y: -ciImage.extent.origin.y))
      }

      // Rotation
      if rotation != 0 {
        let radians = CGFloat(rotation) * .pi / 180.0
        ciImage = ciImage.transformed(by: CGAffineTransform(rotationAngle: radians))
        if ciImage.extent.origin != .zero {
          ciImage = ciImage.transformed(by: CGAffineTransform(translationX: -ciImage.extent.origin.x, y: -ciImage.extent.origin.y))
        }
      }

      // Brightness & Contrast & Saturation via CIColorControls
      let bFactor = brightness / 100.0  // -0.5 to 0.5
      let cFactor = 1.0 + contrast / 100.0  // 0.5 to 1.5
      let sFactor = 1.0 + saturation / 100.0  // 0.5 to 1.5
      if let colorFilter = CIFilter(name: "CIColorControls") {
        colorFilter.setValue(ciImage, forKey: kCIInputImageKey)
        colorFilter.setValue(bFactor, forKey: kCIInputBrightnessKey)
        colorFilter.setValue(cFactor, forKey: kCIInputContrastKey)
        colorFilter.setValue(sFactor, forKey: kCIInputSaturationKey)
        if let result = colorFilter.outputImage { ciImage = result }
      }

      // Warmth via CITemperatureAndTint
      if warmth != 0 {
        if let tempFilter = CIFilter(name: "CITemperatureAndTint") {
          tempFilter.setValue(ciImage, forKey: kCIInputImageKey)
          let neutral = CIVector(x: 6500, y: 0) // neutral white point
          let target = CIVector(x: 6500 + CGFloat(warmth) * 30, y: 0)
          tempFilter.setValue(neutral, forKey: "inputNeutral")
          tempFilter.setValue(target, forKey: "inputTargetNeutral")
          if let result = tempFilter.outputImage { ciImage = result }
        }
      }

      // Grayscale
      if grayscale > 0 {
        if let grayFilter = CIFilter(name: "CIPhotoEffectMono") {
          grayFilter.setValue(ciImage, forKey: kCIInputImageKey)
          if let grayResult = grayFilter.outputImage {
            // Blend: mix original and grayscale based on grayscale percentage
            let alpha = grayscale / 100.0
            if alpha >= 1.0 {
              ciImage = grayResult
            } else if let blendFilter = CIFilter(name: "CIDissolveTransition") {
              blendFilter.setValue(ciImage, forKey: kCIInputImageKey)
              blendFilter.setValue(grayResult, forKey: kCIInputTargetImageKey)
              blendFilter.setValue(alpha, forKey: kCIInputTimeKey)
              if let result = blendFilter.outputImage { ciImage = result }
            }
          }
        }
      }

      // Sepia
      if sepia > 0 {
        if let sepiaFilter = CIFilter(name: "CISepiaTone") {
          sepiaFilter.setValue(ciImage, forKey: kCIInputImageKey)
          sepiaFilter.setValue(sepia / 100.0, forKey: kCIInputIntensityKey)
          if let result = sepiaFilter.outputImage { ciImage = result }
        }
      }

      let context = CIContext(options: [.useSoftwareRenderer: false])
      let finalExtent = ciImage.extent
      guard let cgResult = context.createCGImage(ciImage, from: finalExtent) else {
        throw NSError(domain: "DocumentDetection", code: 11,
                      userInfo: [NSLocalizedDescriptionKey: "Failed to render edited image"])
      }

      let resultImage = UIImage(cgImage: cgResult)
      guard let jpegData = resultImage.jpegData(compressionQuality: 0.92) else {
        throw NSError(domain: "DocumentDetection", code: 12,
                      userInfo: [NSLocalizedDescriptionKey: "Failed to encode JPEG"])
      }

      let resultBase64 = jpegData.base64EncodedString()
      return [
        "base64": resultBase64,
        "width": Int(finalExtent.width),
        "height": Int(finalExtent.height)
      ]
    }

    AsyncFunction("detectDocument") { (base64: String) -> [String: [String: Double]]? in
      guard let data = Data(base64Encoded: base64),
            let image = UIImage(data: data),
            let cgImage = image.cgImage else {
        throw NSError(domain: "DocumentDetection", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "Could not decode base64 image"])
      }

      // Map UIImage orientation to CGImagePropertyOrientation
      let cgOrientation: CGImagePropertyOrientation
      switch image.imageOrientation {
      case .up: cgOrientation = .up
      case .down: cgOrientation = .down
      case .left: cgOrientation = .left
      case .right: cgOrientation = .right
      case .upMirrored: cgOrientation = .upMirrored
      case .downMirrored: cgOrientation = .downMirrored
      case .leftMirrored: cgOrientation = .leftMirrored
      case .rightMirrored: cgOrientation = .rightMirrored
      @unknown default: cgOrientation = .up
      }

      return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[String: [String: Double]]?, Error>) in
        let request = VNDetectRectanglesRequest { request, error in
          if let error = error {
            continuation.resume(throwing: error)
            return
          }

          guard let observations = request.results as? [VNRectangleObservation],
                let rect = observations.first else {
            continuation.resume(returning: nil)
            return
          }

          // Collect all 4 corners, convert from Vision (bottom-left origin) to screen (top-left origin)
          var points: [(x: Double, y: Double)] = [
            (Double(rect.topLeft.x), Double(1 - rect.topLeft.y)),
            (Double(rect.topRight.x), Double(1 - rect.topRight.y)),
            (Double(rect.bottomRight.x), Double(1 - rect.bottomRight.y)),
            (Double(rect.bottomLeft.x), Double(1 - rect.bottomLeft.y))
          ]

          // Clamp to [0, 1]
          points = points.map { (min(max($0.x, 0), 1), min(max($0.y, 0), 1)) }

          // Order corners by visual position: sort by y to get top pair and bottom pair,
          // then sort each pair by x to get left/right
          points.sort { $0.y < $1.y }
          let topPair = [points[0], points[1]].sorted { $0.x < $1.x }
          let bottomPair = [points[2], points[3]].sorted { $0.x < $1.x }

          let tl = topPair[0]
          let tr = topPair[1]
          let bl = bottomPair[0]
          let br = bottomPair[1]

          NSLog("[DocumentDetection] ordered: tl=(%.4f,%.4f) tr=(%.4f,%.4f) bl=(%.4f,%.4f) br=(%.4f,%.4f)",
                tl.x, tl.y, tr.x, tr.y, bl.x, bl.y, br.x, br.y)

          let corners: [String: [String: Double]] = [
            "tl": ["x": tl.x, "y": tl.y],
            "tr": ["x": tr.x, "y": tr.y],
            "br": ["x": br.x, "y": br.y],
            "bl": ["x": bl.x, "y": bl.y]
          ]

          continuation.resume(returning: corners)
        }

        // Configure for document/receipt detection
        request.minimumAspectRatio = 0.2
        request.maximumAspectRatio = 1.0
        request.minimumSize = 0.1
        request.maximumObservations = 1
        request.minimumConfidence = 0.3

        let handler = VNImageRequestHandler(cgImage: cgImage, orientation: cgOrientation, options: [:])
        do {
          try handler.perform([request])
        } catch {
          continuation.resume(throwing: error)
        }
      }
    }
  }
}
