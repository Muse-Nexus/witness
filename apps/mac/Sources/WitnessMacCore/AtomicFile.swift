import Darwin
import Foundation

public enum AtomicFileError: Error, Equatable, CustomStringConvertible {
    case createDirectory(path: String, reason: String)
    case write(path: String, errno: Int32)

    public var description: String {
        switch self {
        case .createDirectory(let path, let reason):
            "Could not create \(path): \(reason)"
        case .write(let path, let code):
            "Could not write \(path): \(String(cString: strerror(code)))"
        }
    }
}

/// Small private files (config, cursor) written so a crash never leaves a half-written file.
enum AtomicFile {
    /// Writes `data` to a new `0600` temporary file in the same directory, flushes
    /// it, then renames it over `url`. The directory is created `0700` if needed.
    static func write(_ data: Data, to url: URL) throws {
        let directory = url.deletingLastPathComponent()
        try createPrivateDirectory(directory)

        let temporary = directory.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw AtomicFileError.write(path: url.path, errno: errno) }

        var failure = writeAll(data, to: descriptor)
        if failure == nil, fsync(descriptor) != 0 { failure = errno }
        close(descriptor)

        if failure == nil, rename(temporary.path, url.path) != 0 { failure = errno }
        if let failure {
            unlink(temporary.path)
            throw AtomicFileError.write(path: url.path, errno: failure)
        }
    }

    static func createPrivateDirectory(_ directory: URL) throws {
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory), isDirectory.boolValue {
            return
        }
        do {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        } catch {
            throw AtomicFileError.createDirectory(path: directory.path, reason: error.localizedDescription)
        }
    }

    /// Returns `errno` on failure, `nil` on success.
    private static func writeAll(_ data: Data, to descriptor: Int32) -> Int32? {
        data.withUnsafeBytes { buffer -> Int32? in
            guard let base = buffer.baseAddress else { return nil }
            var written = 0
            while written < buffer.count {
                let result = Darwin.write(descriptor, base + written, buffer.count - written)
                if result < 0 {
                    if errno == EINTR { continue }
                    return errno
                }
                written += result
            }
            return nil
        }
    }
}
