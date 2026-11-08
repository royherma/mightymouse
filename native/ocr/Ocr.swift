// Ocr.swift — extract on-screen text from an image using the macOS Vision
// framework. Free, local, offline; no model download, no network, no cost.
//
// Usage:  ocr <image-path> [--fast] [--json]
//   --fast  use the fast recognition level (~0.3-0.5s) instead of accurate
//           (~2.4s). Fast is good enough for video keyframes; screenshots use
//           accurate for searchable fidelity.
//   --json  emit one JSON array of {text,x,y,w,h,conf} per recognized line,
//           with x,y,w,h in IMAGE PIXELS (origin top-left), instead of plain
//           text. Used by the "point at / click on screen" feature to turn a
//           label into a coordinate. Vision gives the boxes for free — we just
//           stop discarding them.
//
// Output: without --json, the recognized text, one line per detected line, on
// stdout. With --json, the array described above. Empty stdout / "[]" (exit 0)
// when nothing is found — the caller treats that as "no text", never an error,
// so a blank screenshot can't break enrichment.

import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1 else {
  FileHandle.standardError.write("usage: ocr <image-path> [--fast] [--json]\n".data(using: .utf8)!)
  exit(2)
}

let path = args[1]
let fast = args.contains("--fast")
let json = args.contains("--json")

func emptyResult() -> Never {
  print(json ? "[]" : "")
  exit(0)
}

guard let img = NSImage(contentsOfFile: path),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  // Unreadable image → empty result, not a crash.
  emptyResult()
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = fast ? .fast : .accurate
request.usesLanguageCorrection = !fast

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
  try handler.perform([request])
} catch {
  emptyResult()
}

let observations = request.results ?? []

if !json {
  let lines = observations.compactMap { $0.topCandidates(1).first?.string }
  print(lines.joined(separator: "\n"))
  exit(0)
}

// --json: Vision boundingBox is normalized 0..1 with origin at BOTTOM-left.
// Convert to image PIXELS with origin at TOP-left (what a screenshot coordinate
// system / our cursor overlay expects): scale by image size, flip Y.
let imgW = CGFloat(cg.width)
let imgH = CGFloat(cg.height)
var items: [[String: Any]] = []
for obs in observations {
  guard let candidate = obs.topCandidates(1).first else { continue }
  let bb = obs.boundingBox // normalized, bottom-left origin
  let xPx = bb.origin.x * imgW
  let wPx = bb.size.width * imgW
  let hPx = bb.size.height * imgH
  // Flip Y: top of the box in top-left space = (1 - (origin.y + height)) * H.
  let yPx = (1 - (bb.origin.y + bb.size.height)) * imgH
  items.append([
    "text": candidate.string,
    "x": Int(xPx.rounded()),
    "y": Int(yPx.rounded()),
    "w": Int(wPx.rounded()),
    "h": Int(hPx.rounded()),
    "conf": candidate.confidence
  ])
}

if let data = try? JSONSerialization.data(withJSONObject: items),
   let str = String(data: data, encoding: .utf8) {
  print(str)
} else {
  print("[]")
}
