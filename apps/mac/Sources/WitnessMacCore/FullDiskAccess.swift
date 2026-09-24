import Darwin
import Foundation

public enum FullDiskAccessState: Equatable, Sendable, CustomStringConvertible {
    /// The file opened, so this process can read it.
    case granted
    /// macOS refused (EPERM from privacy protection, or EACCES from file permissions).
    case denied
    /// Nothing is at that path, e.g. Messages has never been set up on this Mac.
    case missing
    /// Some other error; carries `errno` so it can be reported.
    case unavailable(errno: Int32)

    public var description: String {
        switch self {
        case .granted: "granted"
        case .denied: "not granted"
        case .missing: "not found"
        case .unavailable(let code): "unavailable (\(String(cString: strerror(code))))"
        }
    }
}

/// Checks whether this process can read a protected file such as `chat.db`.
///
/// Privacy protection (TCC) hides the real answer from metadata calls:
/// `FileManager.fileExists` reports `true` for `chat.db` even without Full Disk
/// Access. Only actually opening the file tells the truth, so the check calls
/// `open(2)` and reads `errno`.
public enum FullDiskAccess {
    /// Opens System Settings at Privacy & Security > Full Disk Access.
    public static let settingsURLString = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"

    public static func check(path: String) -> FullDiskAccessState {
        let descriptor = open(path, O_RDONLY | O_CLOEXEC)
        if descriptor >= 0 {
            close(descriptor)
            return .granted
        }
        let code = errno
        switch code {
        case EPERM, EACCES: return .denied
        case ENOENT, ENOTDIR: return .missing
        default: return .unavailable(errno: code)
        }
    }

    public static func check(url: URL = MessagesDatabase.defaultURL) -> FullDiskAccessState {
        check(path: url.path)
    }
}
