import Contacts
import Foundation
import os

/// Finds the name a person gave a sender in their own Contacts, so a kept message can
/// say who sent it. The address book never leaves the Mac: only the name of the sender
/// of a message that is already being sent goes with it (`fromName`).
public protocol ContactsResolving: Sendable {
    /// The contact name for a Messages handle (phone number or email address), or `nil`
    /// when nobody matches, or when more than one contact matches and the name would be a guess.
    func name(forHandle handle: String) -> String?
}

/// Whether Witness may read Contacts. On macOS it is all or nothing.
public enum ContactsAccess: String, Equatable, Sendable {
    case notDetermined
    case denied
    case restricted
    case authorized
}

/// Turns phone numbers and email addresses into lookup keys, so the way Messages writes a
/// handle (`+12065550101`) matches the way a contact card does (`(206) 555-0101`).
public enum HandleNormalizer {
    /// Shorter numbers are not people's phones (short codes are excluded long before this).
    static let minimumPhoneDigits = 7
    /// Numbers are compared on their last ten digits, so a country code written on one side
    /// and not the other (`+1 206…` and `206…`, `+44 7700…` and `07700…`) still matches.
    static let comparedPhoneDigits = 10

    /// The lookup key for a Messages handle or a contact's phone number or email address.
    public static func key(for raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return trimmed.contains("@") ? emailKey(trimmed) : phoneKey(trimmed)
    }

    public static func emailKey(_ raw: String) -> String? {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if value.hasPrefix("mailto:") { value.removeFirst("mailto:".count) }
        guard let at = value.firstIndex(of: "@"), at != value.startIndex, value.index(after: at) != value.endIndex,
              !value.contains(where: \.isWhitespace)
        else { return nil }
        return "email:" + value
    }

    public static func phoneKey(_ raw: String) -> String? {
        // Letters mean a sender name ("BANKCO") or a vanity number, never a match.
        guard !raw.contains(where: \.isLetter) else { return nil }
        let digits = raw.compactMap { character -> Character? in
            guard let value = character.wholeNumberValue, character.isNumber, (0...9).contains(value) else { return nil }
            return Character(String(value))
        }
        guard digits.count >= minimumPhoneDigits else { return nil }
        return "phone:" + String(digits.suffix(comparedPhoneDigits))
    }
}

/// One contact card, reduced to what the lookup needs.
public struct ContactRecord: Equatable, Sendable {
    public var name: String
    public var phoneNumbers: [String]
    public var emailAddresses: [String]

    public init(name: String, phoneNumbers: [String] = [], emailAddresses: [String] = []) {
        self.name = name
        self.phoneNumbers = phoneNumbers
        self.emailAddresses = emailAddresses
    }
}

/// A lookup table from handle keys to names. A key that belongs to two different names
/// is dropped: an unknown name stays unknown rather than becoming a guess.
public struct ContactsIndex: Equatable, Sendable {
    private var names: [String: String]

    public init(records: [ContactRecord]) {
        var candidates: [String: Set<String>] = [:]
        for record in records {
            let name = record.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { continue }
            for handle in record.phoneNumbers + record.emailAddresses {
                guard let key = HandleNormalizer.key(for: handle) else { continue }
                candidates[key, default: []].insert(name)
            }
        }
        names = candidates.compactMapValues { $0.count == 1 ? $0.first : nil }
    }

    public var isEmpty: Bool { names.isEmpty }

    public func name(forHandle handle: String) -> String? {
        HandleNormalizer.key(for: handle).flatMap { names[$0] }
    }
}

/// A fixed set of contacts, for tests and previews.
public struct InMemoryContactsResolver: ContactsResolving {
    public let index: ContactsIndex

    public init(records: [ContactRecord]) {
        index = ContactsIndex(records: records)
    }

    public func name(forHandle handle: String) -> String? {
        index.name(forHandle: handle)
    }
}

/// Reads Contacts once, keeps the lookup table in memory, and reads again after Contacts
/// changes (`CNContactStoreDidChange`). Nothing is written to disk.
public final class CachedContactsResolver: ContactsResolving, @unchecked Sendable {
    private struct Cache {
        var index: ContactsIndex?
        /// Bumped by every change notification, so a read that started before a change
        /// is not kept as if it were current.
        var generation = 0
    }

    private let load: @Sendable () throws -> [ContactRecord]
    private let isAllowed: @Sendable () -> Bool
    private let cache = OSAllocatedUnfairLock(initialState: Cache())
    private let loads = OSAllocatedUnfairLock(initialState: 0)
    private let notificationCenter: NotificationCenter
    // Set once in init and only read in deinit.
    private var observer: (any NSObjectProtocol)?

    /// - Parameters:
    ///   - load: reads every contact card. Called on first use and after each change.
    ///   - isAllowed: whether Contacts may be read right now.
    public init(
        notificationCenter: NotificationCenter = .default,
        isAllowed: @escaping @Sendable () -> Bool,
        load: @escaping @Sendable () throws -> [ContactRecord]
    ) {
        self.load = load
        self.isAllowed = isAllowed
        self.notificationCenter = notificationCenter
        observer = notificationCenter.addObserver(forName: .CNContactStoreDidChange, object: nil, queue: nil) { [cache] _ in
            cache.withLock { state in
                state.index = nil
                state.generation += 1
            }
        }
    }

    deinit {
        if let observer { notificationCenter.removeObserver(observer) }
    }

    /// How many times Contacts has been read. For tests.
    public var loadCount: Int { loads.withLock { $0 } }

    public func name(forHandle handle: String) -> String? {
        index()?.name(forHandle: handle)
    }

    /// Forgets the table, so the next lookup reads Contacts again.
    public func invalidate() {
        cache.withLock { state in
            state.index = nil
            state.generation += 1
        }
    }

    private func index() -> ContactsIndex? {
        guard isAllowed() else { return nil }
        let (cached, generation) = cache.withLock { ($0.index, $0.generation) }
        if let cached { return cached }

        loads.withLock { $0 += 1 }
        guard let records = try? load() else { return nil }
        let index = ContactsIndex(records: records)
        cache.withLock { state in
            if state.generation == generation { state.index = index }
        }
        return index
    }
}

/// The system address book.
public enum SystemContacts {
    public static var access: ContactsAccess {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized: .authorized
        case .denied: .denied
        case .restricted: .restricted
        case .notDetermined: .notDetermined
        @unknown default: .denied
        }
    }

    /// Asks macOS for Contacts access. Shows the system prompt the first time only.
    public static func requestAccess() async -> ContactsAccess {
        _ = try? await CNContactStore().requestAccess(for: .contacts)
        return access
    }

    /// A resolver over the real address book. It reads only names, phone numbers and
    /// email addresses, and only while access is allowed.
    public static func resolver(notificationCenter: NotificationCenter = .default) -> CachedContactsResolver {
        CachedContactsResolver(
            notificationCenter: notificationCenter,
            isAllowed: { access == .authorized },
            load: readAll
        )
    }

    @Sendable
    static func readAll() throws -> [ContactRecord] {
        let keys: [any CNKeyDescriptor] = [
            CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
            CNContactNicknameKey as NSString,
            CNContactOrganizationNameKey as NSString,
            CNContactPhoneNumbersKey as NSString,
            CNContactEmailAddressesKey as NSString,
        ]
        let request = CNContactFetchRequest(keysToFetch: keys)
        request.unifyResults = true
        var records: [ContactRecord] = []
        try CNContactStore().enumerateContacts(with: request) { contact, _ in
            let name = displayName(
                formatted: CNContactFormatter.string(from: contact, style: .fullName),
                nickname: contact.nickname,
                organization: contact.organizationName
            )
            guard let name else { return }
            records.append(ContactRecord(
                name: name,
                phoneNumbers: contact.phoneNumbers.map { $0.value.stringValue },
                emailAddresses: contact.emailAddresses.map { $0.value as String }
            ))
        }
        return records
    }

    /// The card's full name, else its nickname, else the company, else nothing.
    static func displayName(formatted: String?, nickname: String, organization: String) -> String? {
        for candidate in [formatted ?? "", nickname, organization] {
            let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        return nil
    }
}
