import Contacts
import Foundation
import os
import Testing
@testable import WitnessMacCore

// Every name, number and address here is fictional (555-01xx, example.com).

@Suite("Contacts names")
struct ContactsResolverTests {
    @Test("Phone numbers match however they are written", arguments: [
        "+12065550101", "+1 (206) 555-0101", "206.555.0101", "(206) 555 0101", "1-206-555-0101", "2065550101",
    ])
    func phoneFormats(written: String) {
        #expect(HandleNormalizer.key(for: written) == "phone:2065550101")
    }

    @Test("A country code on one side only still matches")
    func countryCode() {
        #expect(HandleNormalizer.key(for: "+44 7700 900123") == HandleNormalizer.key(for: "07700 900123"))
        let resolver = InMemoryContactsResolver(records: [ContactRecord(name: "Rosa Example", phoneNumbers: ["07700 900123"])])
        #expect(resolver.name(forHandle: "+447700900123") == "Rosa Example")
    }

    @Test("Email addresses ignore case, spaces and mailto")
    func emails() {
        let key = HandleNormalizer.key(for: "friend@example.com")
        #expect(key == "email:friend@example.com")
        #expect(HandleNormalizer.key(for: "  Friend@Example.COM ") == key)
        #expect(HandleNormalizer.key(for: "mailto:FRIEND@example.com") == key)
        #expect(HandleNormalizer.key(for: "@example.com") == nil)
        #expect(HandleNormalizer.key(for: "friend@") == nil)
    }

    @Test("Short codes, sender names and empty handles have no key")
    func noKey() {
        #expect(HandleNormalizer.key(for: "12345") == nil)
        #expect(HandleNormalizer.key(for: "BANKCO") == nil)
        #expect(HandleNormalizer.key(for: "   ") == nil)
        #expect(HandleNormalizer.key(for: "555-0101 ext 4") == nil)
    }

    @Test("Finds the name for a Messages handle")
    func lookup() {
        let resolver = InMemoryContactsResolver(records: [
            ContactRecord(name: "Ana Example", phoneNumbers: ["(206) 555-0101"], emailAddresses: ["ana@example.com"]),
            ContactRecord(name: "Kai Example", phoneNumbers: ["+1 206 555 0102"]),
        ])
        #expect(resolver.name(forHandle: "+12065550101") == "Ana Example")
        #expect(resolver.name(forHandle: "ANA@example.com") == "Ana Example")
        #expect(resolver.name(forHandle: "+12065550102") == "Kai Example")
        #expect(resolver.name(forHandle: "+12065550199") == nil)
        #expect(resolver.name(forHandle: "someone@example.com") == nil)
    }

    @Test("A number on two different cards gives no name rather than a guess")
    func ambiguous() {
        let resolver = InMemoryContactsResolver(records: [
            ContactRecord(name: "Ana Example", phoneNumbers: ["206-555-0101"]),
            ContactRecord(name: "Ben Example", phoneNumbers: ["+1 206 555 0101"]),
            ContactRecord(name: "Kai Example", emailAddresses: ["kai@example.com"]),
            // The same person twice (linked cards) is not ambiguous.
            ContactRecord(name: "Kai Example", emailAddresses: ["KAI@example.com"]),
            ContactRecord(name: "   ", phoneNumbers: ["206-555-0104"]),
        ])
        #expect(resolver.name(forHandle: "+12065550101") == nil)
        #expect(resolver.name(forHandle: "kai@example.com") == "Kai Example")
        #expect(resolver.name(forHandle: "+12065550104") == nil, "a card with no name gives no name")
    }

    @Test("A card's name is its full name, else nickname, else company")
    func displayName() {
        #expect(SystemContacts.displayName(formatted: "Ana Example", nickname: "Annie", organization: "Example Co") == "Ana Example")
        #expect(SystemContacts.displayName(formatted: nil, nickname: " Annie ", organization: "Example Co") == "Annie")
        #expect(SystemContacts.displayName(formatted: "", nickname: "", organization: "Example Co") == "Example Co")
        #expect(SystemContacts.displayName(formatted: nil, nickname: "", organization: " ") == nil)
    }

    @Test("Reads Contacts once, and again after Contacts changes")
    func cacheRefreshesOnChange() {
        let center = NotificationCenter()
        let cards = OSAllocatedUnfairLock(initialState: [ContactRecord(name: "Ana Example", phoneNumbers: ["206-555-0101"])])
        let resolver = CachedContactsResolver(notificationCenter: center, isAllowed: { true }, load: { cards.withLock { $0 } })

        #expect(resolver.name(forHandle: "+12065550101") == "Ana Example")
        #expect(resolver.name(forHandle: "+12065550101") == "Ana Example")
        #expect(resolver.loadCount == 1)

        cards.withLock { $0 = [ContactRecord(name: "Ana Q. Example", phoneNumbers: ["206-555-0101"])] }
        #expect(resolver.name(forHandle: "+12065550101") == "Ana Example", "still cached until Contacts says it changed")
        center.post(name: .CNContactStoreDidChange, object: nil)
        #expect(resolver.name(forHandle: "+12065550101") == "Ana Q. Example")
        #expect(resolver.loadCount == 2)
    }

    @Test("Without Contacts access nothing is read and no name is given")
    func notAllowed() {
        let allowed = OSAllocatedUnfairLock(initialState: false)
        let resolver = CachedContactsResolver(
            notificationCenter: NotificationCenter(),
            isAllowed: { allowed.withLock { $0 } },
            load: { [ContactRecord(name: "Ana Example", phoneNumbers: ["206-555-0101"])] }
        )
        #expect(resolver.name(forHandle: "+12065550101") == nil)
        #expect(resolver.loadCount == 0)
        allowed.withLock { $0 = true }
        #expect(resolver.name(forHandle: "+12065550101") == "Ana Example")
    }

    @Test("A failed read gives no name and is tried again next time")
    func loadFailure() {
        struct Unreadable: Error {}
        let fails = OSAllocatedUnfairLock(initialState: true)
        let resolver = CachedContactsResolver(notificationCenter: NotificationCenter(), isAllowed: { true }) {
            if fails.withLock({ $0 }) { throw Unreadable() }
            return [ContactRecord(name: "Ana Example", phoneNumbers: ["206-555-0101"])]
        }
        #expect(resolver.name(forHandle: "+12065550101") == nil)
        fails.withLock { $0 = false }
        #expect(resolver.name(forHandle: "+12065550101") == "Ana Example")
        #expect(resolver.loadCount == 2)
    }

    @Test("Scans send fromName only for a sender with one matching card")
    func scannerSendsNames() async throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let scenario = try StandardScenario(url: temp.file("chat.db"))
        let transport = MockTransport()
        let names = InMemoryContactsResolver(records: [
            ContactRecord(name: "Ana Example", phoneNumbers: ["(206) 555-0101"]),
        ])
        let scanner = MessageScanner(
            databaseURL: scenario.database.url,
            prefilter: try Fixtures.prefilter(),
            cursorStore: CursorStore(fileURL: temp.file("cursor.json")),
            sender: WitnessClient(baseURL: URL(string: "https://witness.example.com")!, token: WitnessClientTests.token, transport: transport),
            names: names,
            now: { testNow }
        )
        let summary = try await scanner.scanOnce()
        #expect(summary.sent == StandardScenario.candidateGUIDs.count)

        let bodies = try await transport.bodies()
        let fromAna = try #require(bodies.first { $0["fromHandle"] as? String == "+12065550101" })
        #expect(fromAna["fromName"] as? String == "Ana Example")
        let others = bodies.filter { $0["fromHandle"] as? String != "+12065550101" }
        #expect(!others.isEmpty)
        #expect(others.allSatisfy { $0["fromName"] == nil }, "no card, no name")
    }

    @Test("A name is trimmed and kept within the server's limit")
    func captureName() {
        let message = WitnessClientTests.message
        #expect(CaptureRequest(message: message, fromName: "  Ana Example ").fromName == "Ana Example")
        #expect(CaptureRequest(message: message, fromName: "   ").fromName == nil)
        #expect(CaptureRequest(message: message, fromName: String(repeating: "a", count: 300)).fromName?.count == 200)
    }
}
