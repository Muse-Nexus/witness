import Darwin
import Foundation
import WitnessMacCore

@main
struct WitnessMacCLI {
    static func main() async {
        let processEnvironment = ProcessInfo.processInfo.environment
        let environment = CLIEnvironment(
            // WITNESS_SUPPORT_DIR and WITNESS_TOKEN let tests and scripts run without
            // touching ~/Library/Application Support/Witness or the Keychain.
            paths: .standard(environment: processEnvironment),
            tokenStore: TokenStores.standard(environment: processEnvironment),
            transport: URLSessionTransport(),
            environment: processEnvironment,
            output: { line in print(line) },
            errorOutput: { line in FileHandle.standardError.write(Data((line + "\n").utf8)) },
            readSecret: readSecret,
            useColor: Brand.shouldUseColor(environment: processEnvironment, isTerminal: isatty(STDOUT_FILENO) == 1),
            handlesStopSignals: true
        )
        let code = await CLIRunner(environment: environment).run(arguments: Array(CommandLine.arguments.dropFirst()))
        exit(code)
    }

    /// Reads the device token without echoing it on a terminal, or as one line from a pipe.
    @Sendable
    static func readSecret(prompt: String) -> String? {
        if isatty(STDIN_FILENO) == 1 {
            var buffer = [CChar](repeating: 0, count: 512)
            guard readpassphrase(prompt, &buffer, buffer.count, RPP_REQUIRE_TTY) != nil else { return nil }
            let value = String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
            // Clear the copy of the token left in the buffer.
            _ = buffer.withUnsafeMutableBytes { memset_s($0.baseAddress, $0.count, 0, $0.count) }
            return value.isEmpty ? nil : value
        }
        guard let line = readLine(strippingNewline: true), !line.isEmpty else { return nil }
        return line
    }
}
