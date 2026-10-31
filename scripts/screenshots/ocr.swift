// ocr.swift — print the text Apple's Vision framework reads in a PNG, one line per result (v1.193.0).
//
// capture.mts compiles this once (swiftc) and runs it on every screenshot it is about to write: the
// page's DOM text is checked too, but only the pixels are what is published. A tall page is read in
// overlapping horizontal tiles, because Vision scales a large image down before reading it and the
// small print of a 10,000-pixel capture would otherwise be lost. Accurate level, no language
// correction (a correction "fixes" a serial or a code into a word). macOS only.
//
//   ocr <image.png> [tileHeightPx]
import AppKit
import Foundation
import Vision

let args = CommandLine.arguments
guard args.count >= 2 else {
  FileHandle.standardError.write("usage: ocr <image.png> [tileHeightPx]\n".data(using: .utf8)!)
  exit(2)
}
guard let img = NSImage(contentsOfFile: args[1]),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("ocr: cannot load \(args[1])\n".data(using: .utf8)!)
  exit(2)
}
let tile = args.count >= 3 ? max(200, Int(args[2]) ?? 1600) : 1600
let overlap = 120
var y = 0
while y < cg.height {
  let h = min(tile, cg.height - y)
  guard let part = cg.cropping(to: CGRect(x: 0, y: y, width: cg.width, height: h)) else { break }
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = false
  try VNImageRequestHandler(cgImage: part, options: [:]).perform([req])
  // Vision's origin is bottom-left: print top to bottom.
  let found = (req.results ?? []).sorted { $0.boundingBox.minY > $1.boundingBox.minY }
  for o in found {
    if let t = o.topCandidates(1).first { print(t.string) }
  }
  if y + h >= cg.height { break }
  y += tile - overlap
}
