import Foundation

/// Body of `POST /api/v1/capture` (SPEC §8) for a text message.
public struct CaptureRequest: Encodable, Equatable, Sendable {
    public var sourceType: String
    public var text: String
    public var fromHandle: String?
    public var occurredAt: Int64?
    /// The Messages `guid`, so the server can recognise a message it has seen before.
    public var sourceRef: String
    public var sourceLabel: String
    public var threadKind: ThreadKind?
    /// The sender's name as the person saved it in their own Contacts, when they turned
    /// names on. Left out (never guessed) when there is no single match.
    public var fromName: String?

    public init(message: IncomingMessage, fromName: String? = nil) {
        sourceType = "text"
        text = message.text
        fromHandle = message.handle
        occurredAt = message.occurredAt
        sourceRef = message.guid
        sourceLabel = message.service.sourceLabel
        threadKind = message.threadKind
        self.fromName = fromName.flatMap { name in
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
                .prefix(utf16Units: Self.maximumNameLength)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
    }

    /// The server takes names up to 200 characters as JavaScript counts them: UTF-16 code
    /// units, so an emoji can count as two.
    public static let maximumNameLength = 200
}

extension StringProtocol {
    /// The longest start of the string that fits in `limit` UTF-16 code units (JavaScript's
    /// `length`), without splitting a character: an emoji or accented letter is kept whole or
    /// left out, never cut in half.
    func prefix(utf16Units limit: Int) -> String {
        var units = 0
        var end = startIndex
        for character in self {
            units += character.utf16.count
            guard units <= limit else { break }
            end = index(after: end)
        }
        return String(self[startIndex..<end])
    }
}

/// Counts from `GET /api/v1/status` (SPEC §8). Counts only, never content.
public struct ServerStatus: Decodable, Equatable, Sendable {
    public var saved: Int
    public var maybe: Int
    public var lastCapturedAt: Int64?

    public init(saved: Int, maybe: Int, lastCapturedAt: Int64? = nil) {
        self.saved = saved
        self.maybe = maybe
        self.lastCapturedAt = lastCapturedAt
    }
}

/// What `GET /api/v1/status` said about the address and key.
public enum StatusCheck: Equatable, Sendable {
    case ok(ServerStatus)
    /// 401: the key is not valid, or it was revoked.
    case keyRefused
    /// 403: the key is valid but may not read status (a capture-only phone key).
    case notPermitted
    /// Nothing at this address answers like Witness.
    case notWitness(status: Int?)
    /// The address itself is wrong: no such host, or a certificate that is not trusted.
    case badAddress(AddressProblem)
    /// It could not be reached right now (network, 5xx, 429).
    case unreachable
}

/// Why an address cannot be a Witness, whatever is tried later.
public enum AddressProblem: Equatable, Sendable {
    /// The name does not resolve (a typo, or a domain nobody runs).
    case hostNotFound
    /// TLS failed: an untrusted, expired or mismatched certificate.
    case certificate

    /// Sorts a transport error: a problem with the address itself, or nil for trouble that
    /// may pass (offline, timeouts, a refused connection).
    public static func of(_ error: any Error) -> AddressProblem? {
        guard let urlError = error as? URLError else { return nil }
        switch urlError.code {
        case .cannotFindHost, .dnsLookupFailed:
            return .hostNotFound
        case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot,
             .serverCertificateNotYetValid, .secureConnectionFailed, .clientCertificateRejected,
             .clientCertificateRequired, .appTransportSecurityRequiresSecureConnection:
            return .certificate
        default:
            return nil
        }
    }
}

/// Server response. The quote is deliberately not decoded: the Mac has no use for it.
public struct CaptureResponse: Decodable, Equatable, Sendable {
    public var status: String
    public var id: String?
    public var category: String?
    /// Set on this side, never by the server: it answered 429 (slow down) before accepting
    /// this one, so the next messages should wait a while.
    public var askedToSlowDown = false

    public init(status: String, id: String? = nil, category: String? = nil, askedToSlowDown: Bool = false) {
        self.status = status
        self.id = id
        self.category = category
        self.askedToSlowDown = askedToSlowDown
    }

    private enum CodingKeys: String, CodingKey {
        case status, id, category
    }
}

public enum WitnessClientError: Error, Equatable, CustomStringConvertible {
    /// The server answered with a non-2xx status. `code` is the server's error code, if any.
    case http(status: Int, code: String?)
    case invalidResponse
    case transport(String)
    /// Sending was stopped on this side (Pause) before this attempt.
    case stopped

    /// Worth trying again later: server trouble, rate limiting, or the network.
    public var isTransient: Bool {
        switch self {
        case .http(let status, _): status >= 500 || status == 429 || status == 408
        case .invalidResponse: false
        case .transport: true
        case .stopped: false
        }
    }

    /// The token was refused. Nothing will succeed until it is replaced.
    public var isAuthorizationFailure: Bool {
        if case .http(let status, _) = self { return status == 401 || status == 403 }
        return false
    }

    /// The server read this one request and turned it down (400, 413 or 422): sending the
    /// same message again would not help, so it is skipped. Any other failure (404 or 405
    /// from a wrong address, an answer that is not Witness's) stops the scan and keeps the
    /// cursor, so nothing is lost while the address is fixed.
    public var isRequestRejected: Bool {
        if case .http(let status, _) = self { return status == 400 || status == 413 || status == 422 }
        return false
    }

    public var description: String {
        switch self {
        case .http(let status, let code):
            code.map { "The server answered \(status) (\($0))." } ?? "The server answered \(status)."
        case .invalidResponse:
            "The server's answer could not be read."
        case .transport(let reason):
            "Could not reach the server: \(reason)"
        case .stopped:
            "Stopped before sending."
        }
    }
}

/// Sends one capture request and returns the server's decision.
public protocol CaptureSending: Sendable {
    func capture(_ request: CaptureRequest) async throws -> CaptureResponse
}

/// Performs HTTP requests. Injectable so tests never touch the network.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(requestTimeout: TimeInterval = 30, resourceTimeout: TimeInterval = 60) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = requestTimeout
        configuration.timeoutIntervalForResource = resourceTimeout
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.waitsForConnectivity = false
        session = URLSession(configuration: configuration)
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw WitnessClientError.invalidResponse }
        return (data, http)
    }
}

/// Exponential backoff for transient failures.
public struct RetryPolicy: Sendable, Equatable {
    /// Total attempts, including the first.
    public var maxAttempts: Int
    public var baseDelay: TimeInterval
    public var maxDelay: TimeInterval
    /// Up to this fraction of the delay is added at random, so many Macs do not retry in step.
    public var jitter: Double

    public init(maxAttempts: Int = 4, baseDelay: TimeInterval = 1, maxDelay: TimeInterval = 30, jitter: Double = 0.2) {
        self.maxAttempts = max(1, maxAttempts)
        self.baseDelay = baseDelay
        self.maxDelay = maxDelay
        self.jitter = jitter
    }

    public static let standard = RetryPolicy()

    /// Delay before retry number `retry` (1 for the first retry). A server's
    /// `Retry-After` wins when present, within `maxDelay`.
    public func delay(beforeRetry retry: Int, retryAfter: TimeInterval?) -> TimeInterval {
        if let retryAfter, retryAfter >= 0 {
            return min(retryAfter, maxDelay)
        }
        let exponential = baseDelay * pow(2, Double(max(retry - 1, 0)))
        let spread = jitter > 0 ? Double.random(in: 0...jitter) : 0
        return min(exponential * (1 + spread), maxDelay)
    }
}

/// Talks to a Witness server with a device token.
public struct WitnessClient: CaptureSending {
    public static let userAgent = "witness-mac/\(WitnessMacVersion.current)"

    public let baseURL: URL
    private let token: String
    private let transport: any HTTPTransport
    private let retryPolicy: RetryPolicy
    private let sleep: @Sendable (TimeInterval) async throws -> Void
    private let mayContinue: @Sendable () -> Bool

    /// - Parameter mayContinue: asked before every attempt, retries included. When it says
    ///   no, `capture` stops with `WitnessClientError.stopped` and sends nothing more.
    public init(
        baseURL: URL,
        token: String,
        transport: any HTTPTransport = URLSessionTransport(),
        retryPolicy: RetryPolicy = .standard,
        sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { seconds in
            try await Task.sleep(nanoseconds: UInt64(max(seconds, 0) * 1_000_000_000))
        },
        mayContinue: @escaping @Sendable () -> Bool = { true }
    ) {
        self.baseURL = baseURL
        self.token = token
        self.transport = transport
        self.retryPolicy = retryPolicy
        self.sleep = sleep
        self.mayContinue = mayContinue
    }

    public var captureURL: URL {
        baseURL.appendingPathComponent("api/v1/capture")
    }

    public func capture(_ request: CaptureRequest) async throws -> CaptureResponse {
        let urlRequest = try makeCaptureRequest(request)
        var attempt = 1
        var askedToSlowDown = false
        while true {
            // Checked again after every wait, so a pause during a retry's wait sends nothing.
            guard mayContinue() else { throw WitnessClientError.stopped }
            let failure: WitnessClientError
            let retryAfter: TimeInterval?
            do {
                let (data, response) = try await transport.send(urlRequest)
                if (200..<300).contains(response.statusCode) {
                    guard var decoded = try? JSONDecoder().decode(CaptureResponse.self, from: data) else {
                        throw WitnessClientError.invalidResponse
                    }
                    decoded.askedToSlowDown = askedToSlowDown
                    return decoded
                }
                if response.statusCode == 429 { askedToSlowDown = true }
                failure = .http(status: response.statusCode, code: Self.errorCode(in: data))
                retryAfter = Self.retryAfter(response)
            } catch let error as WitnessClientError {
                failure = error
                retryAfter = nil
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                failure = .transport(Self.describe(error))
                retryAfter = nil
            }

            guard failure.isTransient, attempt < retryPolicy.maxAttempts else { throw failure }
            try await sleep(retryPolicy.delay(beforeRetry: attempt, retryAfter: retryAfter))
            attempt += 1
        }
    }

    /// What a check of the address and key found.
    public enum ConnectionCheck: Equatable, Sendable {
        /// The address is a Witness and the key may capture.
        case ok
        /// The key was refused (401/403).
        case keyRefused
        /// Nothing at this address answers like Witness (404, 405, 410, or an answer that is not Witness's).
        case notWitness(status: Int?)
        /// The address itself is wrong: no such host, or an untrusted certificate.
        case badAddress(AddressProblem)
        /// It could not be reached right now (network, 5xx).
        case unreachable
    }

    public var statusURL: URL {
        baseURL.appendingPathComponent("api/v1/status")
    }

    /// Reads the counts-only status. Device keys have the `status` permission unless they
    /// were made capture-only, which answers 403.
    public func fetchStatus() async -> StatusCheck {
        var request = URLRequest(url: statusURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
        do {
            let (data, response) = try await transport.send(request)
            switch response.statusCode {
            case 200..<300:
                guard let status = try? JSONDecoder().decode(ServerStatus.self, from: data) else {
                    return .notWitness(status: response.statusCode)
                }
                return .ok(status)
            case 401:
                return .keyRefused
            case 403:
                return .notPermitted
            case 408, 429, 500...:
                return .unreachable
            default:
                return .notWitness(status: response.statusCode)
            }
        } catch {
            return AddressProblem.of(error).map(StatusCheck.badAddress) ?? .unreachable
        }
    }

    /// Checks that the address is a Witness and that the key may send to it. Tries the
    /// status first (it adds nothing and reads only counts); a capture-only key cannot
    /// read status, so for that one it falls back to an empty capture.
    public func verifyKey() async -> ConnectionCheck {
        switch await fetchStatus() {
        case .ok:
            return .ok
        case .keyRefused:
            return .keyRefused
        case .notPermitted:
            return await checkConnection()
        case .notWitness(let status):
            return .notWitness(status: status)
        case .badAddress(let problem):
            return .badAddress(problem)
        case .unreachable:
            return .unreachable
        }
    }

    /// Checks the address and key without adding anything: an empty capture is always
    /// turned down (400) by a Witness that accepted the key.
    public func checkConnection() async -> ConnectionCheck {
        var request = URLRequest(url: captureURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
        request.httpBody = Data("{}".utf8)
        do {
            let (data, response) = try await transport.send(request)
            switch response.statusCode {
            case 400, 422:
                return Self.errorCode(in: data) != nil ? .ok : .notWitness(status: response.statusCode)
            case 200..<300:
                return .ok
            case 401, 403:
                return .keyRefused
            case 500...:
                return .unreachable
            default:
                return .notWitness(status: response.statusCode)
            }
        } catch {
            return AddressProblem.of(error).map(ConnectionCheck.badAddress) ?? .unreachable
        }
    }

    func makeCaptureRequest(_ capture: CaptureRequest) throws -> URLRequest {
        var request = URLRequest(url: captureURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        request.httpBody = try encoder.encode(capture)
        return request
    }

    /// The `error.code` from `{ "error": { "code", "message" } }`. The message is not
    /// kept: it is for people reading server logs, and the Mac never prints it.
    private static func errorCode(in data: Data) -> String? {
        struct Envelope: Decodable {
            struct Body: Decodable { var code: String? }
            var error: Body?
        }
        return (try? JSONDecoder().decode(Envelope.self, from: data))?.error?.code
    }

    private static func retryAfter(_ response: HTTPURLResponse) -> TimeInterval? {
        guard let value = response.value(forHTTPHeaderField: "Retry-After") else { return nil }
        return TimeInterval(value.trimmingCharacters(in: .whitespaces))
    }

    private static func describe(_ error: any Error) -> String {
        if let urlError = error as? URLError {
            return urlError.localizedDescription
        }
        return String(describing: type(of: error))
    }
}
