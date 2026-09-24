import Foundation
@testable import WitnessMacCore

/// The synthetic conversation most tests share. Every handle is fictional
/// (555-01xx numbers, example.com addresses).
struct StandardScenario {
    enum Text {
        static let old = "Thank you so much for dinner last spring."
        static let thanks = "Thank you so much for picking me up tonight."
        static let reply = "Anytime, glad I could."
        static let tapback = "Loved “Thank you so much for picking me up tonight.”"
        static let proud = "I’m so proud of you. You handled that with so much grace."
        static let congrats = "Congrats on the new job!! We should celebrate."
        static let businessCode = "Your verification code is 482913"
        static let order = "Thank you for your order. It ships tomorrow."
        static let neutral = "Running late, see you at 6"
        static let madeMyDay = "You made my day ❤️"
        static let otp = "Your code is 123456, don't share it"

        static let all = [old, thanks, reply, tapback, proud, congrats, businessCode, order, neutral, madeMyDay, otp]
        /// Messages that must never leave the Mac in the standard scenario.
        static let neverSent = [old, reply, tapback, businessCode, order, neutral, otp]
    }

    let database: SyntheticChatDatabase
    /// Row ids by role.
    var rows: [String: Int64] = [:]

    var maxRowID: Int64 { rows.values.max() ?? 0 }

    init(url: URL, now: Date = testNow) throws {
        database = try SyntheticChatDatabase(url: url)
        let db = database

        let friendPhone = try db.addHandle("+12065550101")
        let friendEmail = try db.addHandle("friend@example.com")
        let groupMember = try db.addHandle("+12065550102", service: "SMS")
        let shortCode = try db.addHandle("12345", service: "SMS")
        let noReply = try db.addHandle("no-reply@example.com")
        let rcsFriend = try db.addHandle("+12065550103", service: "RCS")
        let otpSender = try db.addHandle("+12065550104", service: "SMS")

        let directPhone = try db.addChat(style: 45, identifier: "+12065550101")
        let directEmail = try db.addChat(style: 45, identifier: "friend@example.com")
        let group = try db.addChat(style: 43, identifier: "chat000000000000000001", service: "SMS")
        let directRCS = try db.addChat(style: 45, identifier: "+12065550103", service: "RCS")

        func ago(_ days: Double) -> Int64 { SyntheticChatDatabase.appleNanoseconds(daysAgo: days, from: now) }

        rows["old"] = try db.addMessage(.init(
            guid: "F0000000-0000-4000-8000-000000000001", text: Text.old,
            handleID: friendPhone, date: ago(60), chatID: directPhone))
        rows["thanks"] = try db.addMessage(.init(
            guid: "F0000000-0000-4000-8000-000000000002", text: Text.thanks,
            handleID: friendPhone, date: ago(2), chatID: directPhone))
        rows["reply"] = try db.addMessage(.init(
            guid: "F0000000-0000-4000-8000-000000000003", text: Text.reply,
            handleID: friendPhone, isFromMe: true, date: ago(2), chatID: directPhone))
        rows["tapback"] = try db.addMessage(.init(
            guid: "F0000000-0000-4000-8000-000000000004", text: Text.tapback,
            handleID: friendPhone, date: ago(2), associatedMessageType: 2000, chatID: directPhone))
        rows["proud"] = try db.addMessage(.init(
            guid: "F0000000-0000-4000-8000-000000000005", text: nil,
            attributedBody: TypedStreamArchiver.attributedBody(Text.proud),
            handleID: friendEmail, date: ago(1.5), chatID: directEmail))
        rows["retracted"] = try db.addMessage(.init(
            guid: "F0000000-0000-4000-8000-000000000006", text: nil,
            handleID: friendEmail, date: ago(1.4), dateRetracted: ago(1.39), chatID: directEmail))
        rows["congrats"] = try db.addMessage(.init(
            guid: "F0000000-0000-4000-8000-000000000007", text: Text.congrats,
            handleID: groupMember, date: ago(1), service: "SMS", chatID: group))
        rows["businessCode"] = try db.addMessage(.init(
            guid: "F0000000-0000-4000-8000-000000000008", text: Text.businessCode,
            handleID: shortCode, date: ago(0.9), service: "SMS"))
        rows["order"] = try db.addMessage(.init(
            guid: "F0000000-0000-4000-8000-000000000009", text: Text.order,
            handleID: noReply, date: ago(0.8)))
        rows["neutral"] = try db.addMessage(.init(
            guid: "F0000000-0000-4000-8000-00000000000A", text: Text.neutral,
            handleID: friendPhone, date: ago(0.7), chatID: directPhone))
        rows["attachmentOnly"] = try db.addMessage(.init(
            guid: "F0000000-0000-4000-8000-00000000000B", text: "\u{FFFC}",
            handleID: friendPhone, date: ago(0.6), chatID: directPhone))
        rows["madeMyDay"] = try db.addMessage(.init(
            guid: "F0000000-0000-4000-8000-00000000000C", text: nil,
            attributedBody: TypedStreamArchiver.attributedBody(Text.madeMyDay),
            handleID: rcsFriend, date: ago(0.5), service: "RCS", dateEdited: ago(0.49), chatID: directRCS))
        rows["groupEvent"] = try db.addMessage(.init(
            guid: "F0000000-0000-4000-8000-00000000000D", text: nil,
            handleID: groupMember, date: ago(0.4), service: "SMS", itemType: 2, chatID: group))
        rows["otp"] = try db.addMessage(.init(
            guid: "F0000000-0000-4000-8000-00000000000E", text: Text.otp,
            handleID: otpSender, date: ago(0.3), service: "SMS"))
    }

    /// GUIDs of the messages the prefilter should send, in row order.
    static let candidateGUIDs = [
        "F0000000-0000-4000-8000-000000000002",
        "F0000000-0000-4000-8000-000000000005",
        "F0000000-0000-4000-8000-000000000007",
        "F0000000-0000-4000-8000-00000000000C",
    ]
}
