import Foundation

/// Options shared by commands that read Messages.
public struct SourceOptions: Equatable, Sendable {
    public var databasePath: String?
    public var lexiconPath: String?
    /// `--lookback-days <n>` or `--lookback all|<n>`; nil when neither was given.
    public var lookback: Lookback?

    public init(databasePath: String? = nil, lexiconPath: String? = nil, lookback: Lookback? = nil) {
        self.databasePath = databasePath
        self.lexiconPath = lexiconPath
        self.lookback = lookback
    }
}

public enum CLICommand: Equatable, Sendable {
    case status(SourceOptions)
    case login(url: String, token: String?)
    case logout
    case scan(SourceOptions, dryRun: Bool)
    case run(SourceOptions)
    case help
    case version
}

public struct CLIUsageError: Error, Equatable, CustomStringConvertible {
    public var message: String

    public init(_ message: String) {
        self.message = message
    }

    public var description: String { message }
}

/// A small hand-rolled parser, to keep the package free of dependencies.
/// Accepts `--flag value` and `--flag=value`.
public enum CLIParser {
    public static let usage = """
        Usage: witness-mac <command> [options]

        Commands
          status                     Full Disk Access, server, cursor. Never shows messages.
          login --url <server> [--token <wit_dev_…>]
                                     Save the server address and device token.
                                     Leave out --token to paste it without it being shown.
          logout                     Remove the device token from the Keychain.
          scan --once [--dry-run]    Look for new messages once, then exit. Prints counts only.
                                     Sends 20 at a time, with a short wait between.
          run                        Keep watching Messages and scan when it changes.

        Options for status, scan and run
          --db <path>                Messages database (default ~/Library/Messages/chat.db)
          --lexicon <path>           lexicon.json from packages/detector

        Options for scan and run
          --lookback-days <n>        How far back to look, in days (default 365 for a first scan)
          --lookback all             Look through every message on this Mac
                                     A longer time than before looks through only the older
                                     messages not looked at yet, once. Nothing is sent twice.

          --help, --version

        Environment
          WITNESS_LEXICON            lexicon.json to use when --lexicon is not given
          WITNESS_SUPPORT_DIR        Folder for config.json and cursor.json
                                     (default ~/Library/Application Support/Witness)
          WITNESS_TOKEN              Device token to use instead of the Keychain (tests, scripts)
        """

    public static func parse(_ arguments: [String]) throws -> CLICommand {
        guard let name = arguments.first else { return .help }
        var reader = ArgumentReader(Array(arguments.dropFirst()))

        switch name {
        case "help", "--help", "-h":
            return .help
        case "version", "--version":
            return .version
        case "status":
            let options = try reader.sourceOptions(command: name, allowLookback: false)
            try reader.finish(command: name)
            return .status(options)
        case "login":
            var url: String?
            var token: String?
            while let flag = try reader.nextFlag(command: name) {
                switch flag {
                case "--url": url = try reader.value(for: flag)
                case "--token": token = try reader.value(for: flag)
                default: throw CLIUsageError("login does not take \(flag).")
                }
            }
            guard let url else { throw CLIUsageError("login needs --url <server>.") }
            return .login(url: url, token: token)
        case "logout":
            try reader.finish(command: name)
            return .logout
        case "scan":
            var dryRun = false
            let options = try reader.sourceOptions(command: name, allowLookback: true) { flag in
                switch flag {
                case "--once": return true
                case "--dry-run": dryRun = true; return true
                default: return false
                }
            }
            return .scan(options, dryRun: dryRun)
        case "run":
            let options = try reader.sourceOptions(command: name, allowLookback: true)
            return .run(options)
        default:
            throw CLIUsageError("Unknown command \(name). Try witness-mac --help.")
        }
    }
}

private struct ArgumentReader {
    private var remaining: [String]
    private var inlineValue: String?

    init(_ arguments: [String]) {
        remaining = arguments
    }

    /// The next `--flag`, splitting `--flag=value` so `value(for:)` can return the value.
    mutating func nextFlag(command: String) throws -> String? {
        guard !remaining.isEmpty else { return nil }
        let argument = remaining.removeFirst()
        guard argument.hasPrefix("--") else {
            throw CLIUsageError("\(command) does not take \(argument).")
        }
        if let equals = argument.firstIndex(of: "=") {
            inlineValue = String(argument[argument.index(after: equals)...])
            return String(argument[..<equals])
        }
        inlineValue = nil
        return argument
    }

    mutating func value(for flag: String) throws -> String {
        if let inlineValue {
            self.inlineValue = nil
            guard !inlineValue.isEmpty else { throw CLIUsageError("\(flag) needs a value.") }
            return inlineValue
        }
        guard let next = remaining.first, !next.hasPrefix("--") else {
            throw CLIUsageError("\(flag) needs a value.")
        }
        remaining.removeFirst()
        return next
    }

    mutating func sourceOptions(
        command: String,
        allowLookback: Bool,
        extra: (String) throws -> Bool = { _ in false }
    ) throws -> SourceOptions {
        var options = SourceOptions()
        while let flag = try nextFlag(command: command) {
            switch flag {
            case "--db":
                options.databasePath = try value(for: flag)
            case "--lexicon":
                options.lexiconPath = try value(for: flag)
            case "--lookback-days" where allowLookback:
                guard options.lookback == nil else { throw CLIUsageError(Self.oneLookback) }
                let raw = try value(for: flag)
                guard let days = Int(raw), (0...Lookback.maximumDays).contains(days) else {
                    throw CLIUsageError("--lookback-days needs a whole number of days from 0 to \(Lookback.maximumDays).")
                }
                options.lookback = .days(days)
            case "--lookback" where allowLookback:
                guard options.lookback == nil else { throw CLIUsageError(Self.oneLookback) }
                let raw = try value(for: flag).lowercased()
                if raw == "all" || raw == "everything" {
                    options.lookback = .everything
                } else if let days = Int(raw), (0...Lookback.maximumDays).contains(days) {
                    options.lookback = .days(days)
                } else {
                    throw CLIUsageError("--lookback needs all, or a whole number of days from 0 to \(Lookback.maximumDays).")
                }
            default:
                if inlineValue == nil, try extra(flag) { continue }
                throw CLIUsageError("\(command) does not take \(flag). Try witness-mac --help.")
            }
        }
        return options
    }

    static let oneLookback = "Give --lookback-days or --lookback, once."

    func finish(command: String) throws {
        if let extra = remaining.first {
            throw CLIUsageError("\(command) does not take \(extra).")
        }
    }
}
