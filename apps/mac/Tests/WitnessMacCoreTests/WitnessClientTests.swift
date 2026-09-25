import Foundation
import os
import Testing
@testable import WitnessMacCore

@Suite("WitnessClient")
struct WitnessClientTests {
    static let token = "wit_dev_" + String(repeating: "S", count: 43)
    static let baseURL = URL(string: "https://witness.example.com")!

    static let message = IncomingMessage(
        rowID: 42,
        guid: "F0000000-0000-4000-8000-000000000042",
        text: "Thank you so much for picking me up tonight.",
        handle: "+12065550101",
        service: .iMessage,
        occurredAt: 1_790_200_000_000,
        threadKind: .direct,
        editedAt: nil
    )

    func client(_ transport: MockTransport, sleeps: SleepRecorder = SleepRecorder()) -> WitnessClient {
        WitnessClient(
            baseURL: Self.baseURL,
            token: Self.token,
            transport: transport,
            retryPolicy: RetryPolicy(maxAttempts: 4, baseDelay: 1, maxDelay: 30, jitter: 0),
            sleep: { await sleeps.record($0) }
        )
    }

    @Test("Posts the SPEC §8 capture body with the device token")
    func requestShape() async throws {
        let transport = MockTransport()
        let response = try await client(transport).capture(CaptureRequest(message: Self.message))
        #expect(response == CaptureResponse(status: "saved", id: "itm_fixture", category: "gratitude"))

        let request = try #require(await transport.requests.first)
        #expect(request.url?.absoluteString == "https://witness.example.com/api/v1/capture")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(Self.token)")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(request.value(forHTTPHeaderField: "User-Agent")?.hasPrefix("witness-mac/") == true)
        #expect(request.timeoutInterval == 30)

        let body = try #require(try await transport.bodies().first)
        #expect(Set(body.keys) == ["sourceType", "text", "fromHandle", "occurredAt", "sourceRef", "sourceLabel", "threadKind"])
        #expect(body["sourceType"] as? String == "text")
        #expect(body["sourceLabel"] as? String == "iMessage")
        #expect(body["sourceRef"] as? String == "F0000000-0000-4000-8000-000000000042")
        #expect(body["fromHandle"] as? String == "+12065550101")
        #expect(body["occurredAt"] as? Int64 == 1_790_200_000_000)
        #expect(body["threadKind"] as? String == "direct")
        #expect(body["text"] as? String == Self.message.text)
    }

    @Test("Unknown fields are left out rather than sent empty")
    func optionalFieldsOmitted() async throws {
        var message = Self.message
        message.handle = nil
        message.occurredAt = nil
        message.threadKind = nil
        message.service = .sms
        let transport = MockTransport()
        _ = try await client(transport).capture(CaptureRequest(message: message))
        let body = try #require(try await transport.bodies().first)
        #expect(Set(body.keys) == ["sourceType", "text", "sourceRef", "sourceLabel"])
        #expect(body["sourceLabel"] as? String == "SMS")
    }

    @Test("A base URL with a path keeps it")
    func baseURLWithPath() {
        let client = WitnessClient(baseURL: URL(string: "https://example.com/witness")!, token: Self.token, transport: MockTransport())
        #expect(client.captureURL.absoluteString == "https://example.com/witness/api/v1/capture")
    }

    @Test("Retries 5xx with exponential backoff, then succeeds")
    func retriesServerErrors() async throws {
        let transport = MockTransport(replies: [.status(503), .status(502), .saved])
        let sleeps = SleepRecorder()
        let response = try await client(transport, sleeps: sleeps).capture(CaptureRequest(message: Self.message))
        #expect(response.status == "saved")
        #expect(await transport.requests.count == 3)
        #expect(await sleeps.delays == [1, 2])
    }

    @Test("Honours Retry-After on 429")
    func retryAfter() async throws {
        let transport = MockTransport(replies: [.status(429, headers: ["Retry-After": "7"]), .saved])
        let sleeps = SleepRecorder()
        _ = try await client(transport, sleeps: sleeps).capture(CaptureRequest(message: Self.message))
        #expect(await sleeps.delays == [7])
    }

    @Test("Says when the server asked to slow down before taking a message")
    func slowDownSignal() async throws {
        let throttled = MockTransport(replies: [.status(429, headers: ["Retry-After": "2"]), .saved])
        #expect(try await client(throttled).capture(CaptureRequest(message: Self.message)).askedToSlowDown)
        let plain = MockTransport(replies: [.status(503), .saved])
        #expect(try await !client(plain).capture(CaptureRequest(message: Self.message)).askedToSlowDown)
    }

    @Test("When the tries run out after a 429, on server trouble or the network, the 429 is what it says")
    func slowDownOutlastsRetries() async throws {
        let busy = MockTransport(replies: [.status(429, body: #"{"error":{"code":"rate_limited","message":"x"}}"#), .status(503), .status(503), .status(503)])
        await #expect(throws: WitnessClientError.http(status: 429, code: "rate_limited")) {
            try await client(busy).capture(CaptureRequest(message: Self.message))
        }
        #expect(await busy.requests.count == 4)
        let offline = MockTransport(replies: [.status(429), .failure(.timedOut), .failure(.timedOut), .failure(.timedOut)])
        await #expect(throws: WitnessClientError.http(status: 429, code: nil)) {
            try await client(offline).capture(CaptureRequest(message: Self.message))
        }
        // A refusal that is not about pace still says what it is.
        let refused = MockTransport(replies: [.status(429), .status(401)])
        await #expect(throws: WitnessClientError.http(status: 401, code: nil)) {
            try await client(refused).capture(CaptureRequest(message: Self.message))
        }
    }

    @Test("Retries network failures")
    func retriesTransport() async throws {
        let transport = MockTransport(replies: [.failure(.networkConnectionLost), .failure(.timedOut), .saved])
        let sleeps = SleepRecorder()
        _ = try await client(transport, sleeps: sleeps).capture(CaptureRequest(message: Self.message))
        #expect(await transport.requests.count == 3)
        #expect(await sleeps.delays == [1, 2])
    }

    @Test("Asks before every attempt, so a pause during a retry's wait sends nothing more")
    func stopsBetweenRetries() async throws {
        let transport = MockTransport(replies: [.status(503, headers: ["Retry-After": "30"])])
        let open = OSAllocatedUnfairLock(initialState: true)
        let sleeps = SleepRecorder()
        let client = WitnessClient(
            baseURL: Self.baseURL,
            token: Self.token,
            transport: transport,
            retryPolicy: RetryPolicy(maxAttempts: 4, baseDelay: 1, maxDelay: 30, jitter: 0),
            sleep: { delay in
                await sleeps.record(delay)
                open.withLock { $0 = false } // Pause pressed while waiting to retry.
            },
            mayContinue: { open.withLock { $0 } }
        )
        await #expect(throws: WitnessClientError.stopped) {
            try await client.capture(CaptureRequest(message: Self.message))
        }
        #expect(await transport.requests.count == 1, "no second request after the pause")
        #expect(await sleeps.delays == [30])
        #expect(!WitnessClientError.stopped.isTransient)

        // Closed from the start: nothing is sent at all.
        let closed = WitnessClient(baseURL: Self.baseURL, token: Self.token, transport: transport, mayContinue: { false })
        await #expect(throws: WitnessClientError.stopped) {
            try await closed.capture(CaptureRequest(message: Self.message))
        }
        #expect(await transport.requests.count == 1)
    }

    @Test("A missing host or an untrusted certificate is a problem with the address; being offline is not")
    func addressProblems() {
        #expect(AddressProblem.of(URLError(.cannotFindHost)) == .hostNotFound)
        #expect(AddressProblem.of(URLError(.dnsLookupFailed)) == .hostNotFound)
        #expect(AddressProblem.of(URLError(.serverCertificateUntrusted)) == .certificate)
        #expect(AddressProblem.of(URLError(.serverCertificateHasUnknownRoot)) == .certificate)
        for code: URLError.Code in [.notConnectedToInternet, .timedOut, .networkConnectionLost, .cannotConnectToHost] {
            #expect(AddressProblem.of(URLError(code)) == nil)
        }
        #expect(AddressProblem.of(CancellationError()) == nil)
    }

    @Test("Gives up after the last attempt")
    func exhaustsRetries() async throws {
        let transport = MockTransport(fallback: .status(500, body: #"{"error":{"code":"internal","message":"x"}}"#))
        let sleeps = SleepRecorder()
        await #expect(throws: WitnessClientError.http(status: 500, code: "internal")) {
            try await client(transport, sleeps: sleeps).capture(CaptureRequest(message: Self.message))
        }
        #expect(await transport.requests.count == 4)
        #expect(await sleeps.delays == [1, 2, 4])
    }

    @Test("Does not retry 4xx", arguments: [400, 401, 403, 404, 413, 422])
    func noRetryOnClientErrors(status: Int) async throws {
        let transport = MockTransport(fallback: .status(status, body: #"{"error":{"code":"bad_request","message":"Invalid body"}}"#))
        let sleeps = SleepRecorder()
        do {
            _ = try await client(transport, sleeps: sleeps).capture(CaptureRequest(message: Self.message))
            Issue.record("expected an error")
        } catch let error as WitnessClientError {
            #expect(error == .http(status: status, code: "bad_request"))
            #expect(!error.isTransient)
            #expect(error.isAuthorizationFailure == (status == 401 || status == 403))
            #expect(!error.description.contains("Invalid body"), "server messages are not repeated")
        }
        #expect(await transport.requests.count == 1)
        #expect(await sleeps.delays.isEmpty)
    }

    @Test("An unreadable success body is an error, not retried")
    func invalidBody() async throws {
        let transport = MockTransport(fallback: .status(200, body: "<html>"))
        await #expect(throws: WitnessClientError.invalidResponse) {
            try await client(transport).capture(CaptureRequest(message: Self.message))
        }
        #expect(await transport.requests.count == 1)
    }

    @Test("Backoff grows, is capped, and adds bounded jitter")
    func backoff() {
        let policy = RetryPolicy(maxAttempts: 6, baseDelay: 1, maxDelay: 10, jitter: 0)
        #expect((1...5).map { policy.delay(beforeRetry: $0, retryAfter: nil) } == [1, 2, 4, 8, 10])
        #expect(policy.delay(beforeRetry: 1, retryAfter: 120) == 10)

        let jittered = RetryPolicy(baseDelay: 2, maxDelay: 30, jitter: 0.2)
        for _ in 0..<100 {
            let delay = jittered.delay(beforeRetry: 1, retryAfter: nil)
            #expect(delay >= 2 && delay <= 2.4)
        }
    }
}
