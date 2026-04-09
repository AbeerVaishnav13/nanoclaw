import AppKit

class StatusBarController: NSObject {
    private var statusItem: NSStatusItem!
    private var timer: Timer?

    private enum ServiceState: Equatable {
        case stopped          // Red
        case noContainer      // Yellow
        case containerIdle    // Green
        case containerActive  // Orange
    }

    private var state: ServiceState = .stopped

    private let plistPath = "\(NSHomeDirectory())/Library/LaunchAgents/com.nanoclaw.plist"

    /// Derive the NanoClaw project root from the binary location.
    /// The binary is compiled to {project}/dist/statusbar, so the parent of
    /// the parent directory is the project root.
    private static let projectRoot: String = {
        let binary = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        return binary.deletingLastPathComponent().deletingLastPathComponent().path
    }()

    override init() {
        super.init()
        setupStatusItem()
        state = checkState()
        updateStatusTitle()
        updateMenu()
        // Poll every 5 seconds to reflect external state changes
        timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            let current = self.checkState()
            if current != self.state {
                self.state = current
                self.updateStatusTitle()
                self.updateMenu()
            }
        }
    }

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.toolTip = "NanoClaw"
        }
    }

    private func updateStatusTitle() {
        guard let button = statusItem.button else { return }

        let symbolName: String
        let symbolColor: NSColor
        switch state {
        case .stopped:
            symbolName = "stop.fill"
            symbolColor = .systemRed
        case .noContainer:
            symbolName = "pause.fill"
            symbolColor = .systemBlue
        case .containerIdle:
            symbolName = "play.fill"
            symbolColor = .systemGreen
        case .containerActive:
            symbolName = "arrow.trianglehead.2.clockwise"
            symbolColor = .systemOrange
        }

        let lobster = NSMutableAttributedString(string: "🦞", attributes: [
            .font: NSFont.systemFont(ofSize: 14)
        ])

        if let sfImage = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil) {
            let config = NSImage.SymbolConfiguration(paletteColors: [symbolColor])
            let tinted = sfImage.withSymbolConfiguration(config) ?? sfImage
            let sized = NSImage(size: NSSize(width: 7, height: 7))
            sized.lockFocus()
            tinted.draw(in: NSRect(x: 0, y: 0, width: 7, height: 7))
            sized.unlockFocus()

            let attachment = NSTextAttachment()
            attachment.image = sized
            let symbolStr = NSMutableAttributedString(attachment: attachment)
            symbolStr.addAttribute(.baselineOffset, value: -2, range: NSRange(location: 0, length: symbolStr.length))
            lobster.append(symbolStr)
        }

        button.attributedTitle = lobster
    }

    private func checkServiceRunning() -> Bool {
        let task = Process()
        task.launchPath = "/bin/launchctl"
        task.arguments = ["list", "com.nanoclaw"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = Pipe()
        guard (try? task.run()) != nil else { return false }
        task.waitUntilExit()
        if task.terminationStatus != 0 { return false }
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let pid = output.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\t").first ?? "-"
        return pid != "-"
    }

    private func checkContainerRunning() -> Bool {
        let task = Process()
        task.launchPath = "/usr/local/bin/docker"
        task.arguments = ["ps", "--filter", "name=nanoclaw-", "--format", "{{.Names}}"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = Pipe()
        guard (try? task.run()) != nil else { return false }
        task.waitUntilExit()
        if task.terminationStatus != 0 { return false }
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Check if the container is actively processing (true) or idle after responding (false).
    /// Looks at the last 8KB of nanoclaw.log for lifecycle markers:
    ///   "Spawning container agent"            → just started, actively processing
    ///   "Piped messages to active container"   → new message sent to running container
    ///   "Agent output:"                        → has responded, now idle-waiting
    private func checkRecentActivity() -> Bool {
        let logPath = "\(StatusBarController.projectRoot)/logs/nanoclaw.log"
        guard let fh = FileHandle(forReadingAtPath: logPath) else { return false }
        defer { fh.closeFile() }

        let fileSize = fh.seekToEndOfFile()
        let readSize: UInt64 = min(fileSize, 8192)
        if readSize == 0 { return false }
        fh.seek(toFileOffset: fileSize - readSize)
        let data = fh.readDataToEndOfFile()
        guard let tail = String(data: data, encoding: .utf8) else { return false }

        // Find the most recent "work started" marker (spawn or piped message)
        let spawnRange = tail.range(of: "Spawning container agent", options: .backwards)
        let pipedRange = tail.range(of: "Piped messages to active container", options: .backwards)
        let outputRange = tail.range(of: "Agent output:", options: .backwards)

        // Pick the latest "work started" marker
        var latestWork: Range<String.Index>? = nil
        if let s = spawnRange, let p = pipedRange {
            latestWork = s.lowerBound > p.lowerBound ? s : p
        } else {
            latestWork = spawnRange ?? pipedRange
        }

        // No work marker found → not active
        guard let work = latestWork else { return false }

        // If agent has produced output after the latest work marker, it's idle (green)
        if let output = outputRange, output.lowerBound > work.lowerBound {
            return false
        }

        // Work marker found but no output yet → still processing (orange)
        return true
    }

    private func checkState() -> ServiceState {
        if !checkServiceRunning() { return .stopped }
        if !checkContainerRunning() { return .noContainer }
        if checkRecentActivity() { return .containerActive }
        return .containerIdle
    }

    private func updateMenu() {
        let menu = NSMenu()

        // Status row with SF Symbol
        let statusMenuItem = NSMenuItem()
        let symbolName: String
        let symbolColor: NSColor
        let label: String
        switch state {
        case .stopped:
            symbolName = "stop.fill"
            symbolColor = .systemRed
            label = "NanoClaw is stopped"
        case .noContainer:
            symbolName = "pause.fill"
            symbolColor = .systemBlue
            label = "NanoClaw running (idle)"
        case .containerIdle:
            symbolName = "play.fill"
            symbolColor = .systemGreen
            label = "NanoClaw running (container ready)"
        case .containerActive:
            symbolName = "arrow.trianglehead.2.clockwise"
            symbolColor = .systemOrange
            label = "NanoClaw running (processing...)"
        }
        let attr = NSMutableAttributedString()
        if let img = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil) {
            let config = NSImage.SymbolConfiguration(paletteColors: [symbolColor])
            let tinted = img.withSymbolConfiguration(config) ?? img
            let sized = NSImage(size: NSSize(width: 12, height: 12))
            sized.lockFocus()
            tinted.draw(in: NSRect(x: 0, y: 0, width: 12, height: 12))
            sized.unlockFocus()
            let attachment = NSTextAttachment()
            attachment.image = sized
            attr.append(NSAttributedString(attachment: attachment))
            attr.append(NSAttributedString(string: " "))
        }
        attr.append(NSAttributedString(string: label, attributes: [.foregroundColor: NSColor.labelColor]))
        statusMenuItem.attributedTitle = attr
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)

        menu.addItem(NSMenuItem.separator())

        if state == .stopped {
            let start = NSMenuItem(title: "Start", action: #selector(startService), keyEquivalent: "")
            start.target = self
            menu.addItem(start)
        } else {
            let stop = NSMenuItem(title: "Stop", action: #selector(stopService), keyEquivalent: "")
            stop.target = self
            menu.addItem(stop)

            let restart = NSMenuItem(title: "Restart", action: #selector(restartService), keyEquivalent: "r")
            restart.target = self
            menu.addItem(restart)
        }

        menu.addItem(NSMenuItem.separator())

        let logs = NSMenuItem(title: "View Logs", action: #selector(viewLogs), keyEquivalent: "")
        logs.target = self
        menu.addItem(logs)

        self.statusItem.menu = menu
    }

    @objc private func startService() {
        run("/bin/launchctl", ["load", plistPath])
        refresh(after: 2)
    }

    @objc private func stopService() {
        run("/bin/launchctl", ["unload", plistPath])
        refresh(after: 2)
    }

    @objc private func restartService() {
        let uid = getuid()
        run("/bin/launchctl", ["kickstart", "-k", "gui/\(uid)/com.nanoclaw"])
        refresh(after: 3)
    }

    @objc private func viewLogs() {
        let logPath = "\(StatusBarController.projectRoot)/logs/nanoclaw.log"
        NSWorkspace.shared.open(URL(fileURLWithPath: logPath))
    }

    private func refresh(after seconds: Double) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard let self else { return }
            self.state = self.checkState()
            self.updateStatusTitle()
            self.updateMenu()
        }
    }

    @discardableResult
    private func run(_ path: String, _ args: [String]) -> Int32 {
        let task = Process()
        task.launchPath = path
        task.arguments = args
        task.standardOutput = Pipe()
        task.standardError = Pipe()
        try? task.run()
        task.waitUntilExit()
        return task.terminationStatus
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = StatusBarController()
app.run()
