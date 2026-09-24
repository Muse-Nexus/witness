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
    /// A number written without its country code is compared on its last ten digits, so
    /// `+1 206…` matches `206…` and `+44 7700…` matches `07700…`.
    static let comparedPhoneDigits = 10

    /// A phone number reduced to its digits.
    public struct PhoneNumber: Hashable, Sendable {
        /// Every digit, after a leading `+` or `00`.
        public var digits: String
        /// Written with its country code (`+44 …` or `0044 …`), so `digits` is the whole
        /// international number and can be compared exactly.
        public var isInternational: Bool

        /// The last ten digits, for a number written without its country code.
        public var suffix: String { String(digits.suffix(HandleNormalizer.comparedPhoneDigits)) }
    }

    /// The lookup key for a Messages handle or a contact's email address, or the
    /// last-ten-digits key for a phone number.
    public static func key(for raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.contains("@") { return emailKey(trimmed) }
        return phoneNumber(trimmed).map { "phone:" + $0.suffix }
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
        phoneNumber(raw).map { "phone:" + $0.suffix }
    }

    public static func phoneNumber(_ raw: String) -> PhoneNumber? {
        // Letters mean a sender name ("BANKCO") or a vanity number, never a match.
        guard !raw.contains(where: \.isLetter) else { return nil }
        var digits = String(raw.compactMap { character -> Character? in
            guard let value = character.wholeNumberValue, character.isNumber, (0...9).contains(value) else { return nil }
            return Character(String(value))
        })
        let lead = raw.drop { $0.isWhitespace || $0 == "(" }
        var isInternational = lead.first == "+"
        if !isInternational, digits.hasPrefix("00") {
            // 00 is the international prefix in most of the world.
            digits.removeFirst(2)
            isInternational = true
        }
        guard digits.count >= minimumPhoneDigits else { return nil }
        return PhoneNumber(digits: digits, isInternational: isInternational)
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

/// A lookup table from handles to names. A handle that fits two different names gives no
/// name: an unknown name stays unknown rather than becoming a guess.
///
/// Phone numbers: when both the handle and the card's number carry a country code, they
/// must be the same whole number (`+44 20 7946 0123` never matches `+1 207 946 0123`).
/// When either one was written without a country code, the last ten digits are compared.
public struct ContactsIndex: Equatable, Sendable {
    private struct PhoneEntry: Hashable, Sendable {
        var name: String
        /// All digits when the card's number has a country code, else nil.
        var international: String?
    }

    private var emails: [String: Set<String>] = [:]
    /// Keyed by the last ten digits.
    private var phones: [String: Set<PhoneEntry>] = [:]

    public init(records: [ContactRecord]) {
        for record in records {
            let name = record.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { continue }
            for address in record.emailAddresses {
                guard let key = HandleNormalizer.emailKey(address) else { continue }
                emails[key, default: []].insert(name)
            }
            for number in record.phoneNumbers {
                guard let phone = HandleNormalizer.phoneNumber(number) else { continue }
                phones[phone.suffix, default: []].insert(PhoneEntry(name: name, international: phone.isInternational ? phone.digits : nil))
            }
        }
    }

    public var isEmpty: Bool { emails.isEmpty && phones.isEmpty }

    public func name(forHandle handle: String) -> String? {
        let trimmed = handle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let names: Set<String>
        if trimmed.contains("@") {
            guard let key = HandleNormalizer.emailKey(trimmed) else { return nil }
            names = emails[key] ?? []
        } else {
            guard let phone = HandleNormalizer.phoneNumber(trimmed) else { return nil }
            let entries = phones[phone.suffix] ?? []
            names = Set(entries.lazy.filter { entry in
                guard phone.isInternational, let international = entry.international else { return true }
                return international == phone.digits
            }.map(\.name))
        }
        return names.count == 1 ? names.first : nil
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
