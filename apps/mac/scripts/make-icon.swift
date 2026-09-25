// Draws the Witness for Mac icon: a coral opening quote on ink, in the Muse Nexus palette
// (SPEC §4). Writes an .iconset folder for iconutil.
//
//   swift scripts/make-icon.swift <output.iconset>
//
// Run by scripts/build-app.sh; nothing it makes is checked in.

import AppKit
import CoreText
import Foundation

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: swift make-icon.swift <output.iconset>\n".utf8))
    exit(64)
}
let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try? FileManager.default.removeItem(at: output)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

// --ink oklch(0% 0 0), dark-mode --coral oklch(71% .17 25), --cream at 14% for the hairline.
let ink = CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 1)
let coral = CGColor(srgbRed: 250 / 255, green: 112 / 255, blue: 106 / 255, alpha: 1)
let hairline = CGColor(srgbRed: 247 / 255, green: 242 / 255, blue: 232 / 255, alpha: 0.14)

/// Draws the icon on a 1024-point canvas scaled to `pixels`.
func render(pixels: Int) throws -> Data {
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    guard let context = CGContext(
        data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
        space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { throw CocoaError(.fileWriteUnknown) }
    let scale = CGFloat(pixels) / 1024
    context.scaleBy(x: scale, y: scale)
    context.setShouldAntialias(true)

    // The macOS icon grid: an 824-point rounded square centred on the canvas.
    let body = CGRect(x: 100, y: 100, width: 824, height: 824)
    let shape = CGPath(roundedRect: body, cornerWidth: 186, cornerHeight: 186, transform: nil)
    context.addPath(shape)
    context.setFillColor(ink)
    context.fillPath()
    context.addPath(CGPath(roundedRect: body.insetBy(dx: 3, dy: 3), cornerWidth: 183, cornerHeight: 183, transform: nil))
    context.setStrokeColor(hairline)
    context.setLineWidth(6)
    context.strokePath()

    // An opening quotation mark in the system serif (New York), like the evidence quotes.
    let base = NSFont.systemFont(ofSize: 1300, weight: .semibold)
    let serif = base.fontDescriptor.withDesign(.serif).flatMap { NSFont(descriptor: $0, size: 1300) } ?? base
    let attributes: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): serif,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): coral,
    ]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: "\u{201C}", attributes: attributes))
    let bounds = CTLineGetImageBounds(line, context)
    // Centre the ink of the glyph, a little above the middle where quotes sit.
    let x = body.midX - bounds.width / 2 - bounds.minX
    let y = body.midY - bounds.height / 2 - bounds.minY + 10
    context.textPosition = CGPoint(x: x, y: y)
    CTLineDraw(line, context)

    guard let image = context.makeImage() else { throw CocoaError(.fileWriteUnknown) }
    let rep = NSBitmapImageRep(cgImage: image)
    guard let png = rep.representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
    return png
}

let sizes: [(points: Int, scale: Int)] = [
    (16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2),
]
for (points, scale) in sizes {
    let name = scale == 1 ? "icon_\(points)x\(points).png" : "icon_\(points)x\(points)@2x.png"
    try render(pixels: points * scale).write(to: output.appendingPathComponent(name))
}
print("Wrote \(output.path)")
