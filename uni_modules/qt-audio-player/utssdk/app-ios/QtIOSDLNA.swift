import Foundation

/// Ordinary DLNA sender/controller. All session state and the AVTransport FIFO
/// run on the main queue; networking and the media server do no local decoding.
public final class QtIOSDLNA: NSObject {
    public static let shared = QtIOSDLNA()
    private struct Track: Codable {
        let mediaId: String
        let uri: String
        let title: String
        let artist: String
        let album: String
        let coverUrl: String
        let duration: Double?
    }
    private struct SOAPJob {
        let service: QtIOSDLNAService
        let action: String
        let arguments: [(String, String)]
        let valid: () -> Bool
        let completion: (Bool, QtIOSXMLNode?, String) -> Void
    }

    private struct PlayingEvidence {
        let session: UInt64
        let generation: UInt64
        let playback: UInt64
        let seek: UInt64
        let control: UInt64
        let uri: String
        let position: Double
        let monotonic: Double
    }

    private let network = URLSession(configuration: .default)
    private var devices: [String: QtIOSDLNADevice] = [:]
    private var discoveryEpoch: UInt64 = 0
    private var active = false
    private var device: QtIOSDLNADevice?
    private var session: UInt64 = 0
    private var generation: UInt64 = 0
    private var playbackRevision: UInt64 = 0
    private var seekRevision: UInt64 = 0
    private var volumeRevision: UInt64 = 0
    private var controlRevision: UInt64 = 0
    private var pollSequence: UInt64 = 0
    private var queue: [Track] = []
    private var index = -1
    private var repeatMode = 0
    private var mediaID = ""
    private var mediaURI = ""
    private var position = 0.0
    private var duration = 0.0
    private var volume = 1.0
    private var intent = false
    private var phase = "idle"
    private var error = ""
    private var prepared = false
    private var deferredSeek: Double?
    private var transportStarted = false
    private var transportBusy = false
    private var lastConfirmedPlaying: PlayingEvidence?
    private var lastDevicePosition = 0.0
    private var manuallyStopped = false
    private var endConsumed = false
    private var foreignMediaCount = 0
    private var pollFailures = 0
    private var pollBusy = false
    private var pollTimer: Timer?
    private var resolveTimer: DispatchWorkItem?
    private var sourceTask: URLSessionDownloadTask?
    private var relayTemporary: URL?
    private var mediaServer: QtIOSDLNAMediaServer?
    private var serverReady = false
    private var serverStarting = false
    private var serverAddress = ""
    private var serverRevision: UInt64 = 0
    private var serverWaiters: [(Bool) -> Void] = []
    private var relayToken = ""
    private var jobs: [SOAPJob] = []
    private var soapBusy = false
    private var stateListener: ((String) -> Void)?
    private var resolveListener: ((String, String, Bool) -> Void)?
    private var trackListener: ((String, Bool) -> Void)?

    private override init() {
        super.init()
        let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("qt-dlna", isDirectory: true)
        // A terminated process can leave its complete relay staging file.
        // This dedicated directory contains only the controller's temporary media.
        for name in (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? [] {
            if name.hasPrefix("song-") { try? FileManager.default.removeItem(at: folder.appendingPathComponent(name)) }
        }
    }
    private func onMain(_ action: @escaping () -> Void) {
        if Thread.isMainThread { action() } else { DispatchQueue.main.async(execute: action) }
    }
    private func mainValue<T>(_ action: () -> T) -> T {
        if Thread.isMainThread { return action() }
        return DispatchQueue.main.sync(execute: action)
    }
    private func number(_ value: String, _ fallback: Double = 0) -> Double {
        guard let n = Double(value), n.isFinite else { return fallback }
        return n
    }
    private func matches(_ s: UInt64, _ g: UInt64) -> Bool { active && session == s && generation == g }
    private func revokePlayingEvidence() { lastConfirmedPlaying = nil }
    private func matchesPoll(_ s: UInt64, _ g: UInt64, _ playback: UInt64, _ seek: UInt64, _ control: UInt64, _ poll: UInt64) -> Bool {
        matches(s, g) && playbackRevision == playback && seekRevision == seek &&
            controlRevision == control && pollSequence == poll && pollBusy
    }
    private func finishPoll(_ s: UInt64, _ g: UInt64, _ poll: UInt64) {
        // An obsolete callback must not release a newer generation's poll.
        if matches(s, g) && pollSequence == poll { pollBusy = false }
    }
    private func uriMatchesMedia(_ uri: String) -> Bool {
        guard !uri.isEmpty, !mediaURI.isEmpty, let expected = URL(string: mediaURI),
              let observed = URL(string: uri) else { return false }
        return observed.absoluteString == expected.absoluteString
    }
    private func deviceSeconds(_ text: String) -> Double? {
        let parts = text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 3, let hours = Double(parts[0]), let minutes = Double(parts[1]),
              let seconds = Double(parts[2]), hours.isFinite, minutes.isFinite, seconds.isFinite,
              hours >= 0, minutes >= 0, minutes < 60, seconds >= 0, seconds < 60 else { return nil }
        let value = hours * 3600 + minutes * 60 + seconds
        return value.isFinite ? value : nil
    }

    public func setListeners(_ state: @escaping (String) -> Void,
                             _ resolve: @escaping (String, String, Bool) -> Void,
                             _ track: @escaping (String, Bool) -> Void) {
        mainValue { stateListener = state; resolveListener = resolve; trackListener = track }
    }
    public func isActive() -> Bool { mainValue { active } }
    public func isIntendingToPlay() -> Bool { mainValue { intent } }
    public func state() -> String { mainValue { stateJSON() } }
    public func timelineSize() -> String { mainValue { String(queue.count) } }
    public func currentTimelineIndex() -> String { mainValue { String(index) } }

    private func stateJSON() -> String {
        let state: [String: Any] = [
            "target": active ? "dlna" : "local", "sessionId": session, "generation": generation,
            "deviceId": active ? (device?.id ?? "") : "", "deviceName": active ? (device?.name ?? "") : "",
            "phase": phase, "mediaId": mediaID, "timelineIndex": index, "positionMs": position * 1000,
            "durationMs": duration * 1000, "volume": volume,
            "canSeek": active && (device?.canSeek ?? false),
            "canSetVolume": active && (device?.canVolume ?? false), "error": error
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: state),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    private func publish() {
        let json = stateJSON()
        if active { QtIOSAudio.shared.publishRemote(json, intent) }
        stateListener?(json)
    }

    private func fail(_ message: String) {
        controlRevision &+= 1
        revokePlayingEvidence()
        error = message
        phase = "error"
        publish()
    }

    public func discover(_ callback: @escaping (String, String) -> Void) {
        mainValue {
            discoveryEpoch &+= 1
            let epoch = discoveryEpoch
            guard let ip = QtIOSDLNAProtocol.wifiAddress() else {
                callback("[]", "请连接与播放设备相同的局域网")
                return
            }
            DispatchQueue.global(qos: .utility).async {
                let (locations, error) = QtIOSDLNAProtocol.discoverLocations(ip)
                self.onMain {
                    guard self.discoveryEpoch == epoch else { callback("[]", "发现操作已被新的搜索替代"); return }
                    if locations.isEmpty { callback("[]", error); return }
                    let group = DispatchGroup()
                    var found: [String: QtIOSDLNADevice] = [:]
                    for location in locations {
                        group.enter()
                        self.fetch(location) { data in
                            guard let data = data, let renderer = QtIOSDLNAProtocol.device(data, location) else {
                                group.leave(); return
                            }
                            self.loadCapabilities(renderer) { enriched in
                                if enriched.actions.contains("SetAVTransportURI") && enriched.actions.contains("Play") {
                                    found[enriched.id] = enriched
                                }
                                group.leave()
                            }
                        }
                    }
                    group.notify(queue: .main) {
                        guard self.discoveryEpoch == epoch else { callback("[]", "发现操作已被新的搜索替代"); return }
                        self.devices = found
                        let list = found.values.sorted { $0.name < $1.name }.map {
                            ["id": $0.id, "name": $0.name, "canSeek": $0.canSeek, "canSetVolume": $0.canVolume] as [String: Any]
                        }
                        let data = try? JSONSerialization.data(withJSONObject: list)
                        callback(data.flatMap { String(data: $0, encoding: .utf8) } ?? "[]", error)
                    }
                }
            }
        }
    }

    private func fetch(_ url: URL, _ done: @escaping (Data?) -> Void) {
        var request = URLRequest(url: url)
        request.timeoutInterval = 6
        network.dataTask(with: request) { data, response, _ in
            let valid = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
            self.onMain { done(valid && (data?.count ?? 0) <= 1024 * 1024 ? data : nil) }
        }.resume()
    }

    private func loadCapabilities(_ renderer: QtIOSDLNADevice, _ done: @escaping (QtIOSDLNADevice) -> Void) {
        var result = renderer
        fetch(renderer.transport.scpd) { data in
            if let data = data, let root = QtIOSXMLParser.parse(data) {
                result.actions = Set(root.descendants("action").map { $0.value("name") })
            }
            guard let rendering = renderer.rendering else { done(result); return }
            self.fetch(rendering.scpd) { data in
                if let data = data, let root = QtIOSXMLParser.parse(data) {
                    result.volumeActions = Set(root.descendants("action").map { $0.value("name") })
                    if let volume = root.descendants("stateVariable").first(where: { $0.value("name") == "Volume" }),
                       let range = volume.child("allowedValueRange") {
                        let minimum = self.number(range.value("minimum"))
                        let maximum = self.number(range.value("maximum"), 100)
                        if maximum > minimum { result.minimumVolume = minimum; result.maximumVolume = maximum }
                    }
                }
                done(result)
            }
        }
    }

    public func connect(_ id: String) -> Bool {
        mainValue {
            guard let selected = devices[id], let ip = QtIOSDLNAProtocol.wifiAddress() else { return false }
            let previous = device
            let wasActive = active
            retireMedia()
            if !serverAddress.isEmpty && serverAddress != ip {
                serverRevision &+= 1
                mediaServer?.stop()
                mediaServer = nil
                serverReady = false
                serverStarting = false
                let obsolete = serverWaiters
                serverWaiters = []
                obsolete.forEach { $0(false) }
            }
            session &+= 1
            active = true
            device = selected
            relayToken = UUID().uuidString.replacingOccurrences(of: "-", with: "")
            phase = "connected"
            error = ""
            QtIOSAudio.shared.suspendForRemote()
            publish()
            if wasActive, let previous = previous {
                enqueue(previous.transport, "Stop", [("InstanceID", "0")], valid: { true }) { _, _, _ in }
            }
            return true
        }
    }

    public func setPlaylist(_ json: String, _ start: String, _ autoPlay: Bool, _ startPosition: String) {
        mainValue {
            guard active, let data = json.data(using: .utf8),
                  let tracks = try? JSONDecoder().decode([Track].self, from: data),
                  tracks.allSatisfy({ !$0.mediaId.isEmpty && !$0.uri.isEmpty }) else { return }
            queue = tracks
            if tracks.isEmpty { QtIOSAudio.shared.setRemotePlaylist(json, "-1"); stop(); return }
            let selected = Int(max(0, min(Double(tracks.count - 1), number(start))))
            QtIOSAudio.shared.setRemotePlaylist(json, String(selected))
            load(selected, max(0, number(startPosition)), autoPlay, false)
        }
    }

    public func syncTimeline(_ json: String, _ expectedID: String) {
        mainValue {
            guard active, !expectedID.isEmpty, mediaID == expectedID,
                  let data = json.data(using: .utf8),
                  let tracks = try? JSONDecoder().decode([Track].self, from: data),
                  let selected = QtIOSAudioOccurrence.index(queue.map { $0.mediaId }, index,
                                                            tracks.map { $0.mediaId }, expectedID),
                  tracks.allSatisfy({ !$0.mediaId.isEmpty && !$0.uri.isEmpty }) else { return }
            queue = tracks
            index = selected
            QtIOSAudio.shared.setRemotePlaylist(json, String(selected))
        }
    }
    public func setRepeatMode(_ mode: String) { mainValue { repeatMode = Int(max(0, min(2, number(mode)))) } }
    public func playTimelineIndex(_ selected: String) {
        mainValue {
            let value = number(selected, -1)
            guard active, value >= 0, value < Double(queue.count) else { return }
            load(Int(value), 0, true, false)
        }
    }

    private func retireMedia() {
        generation &+= 1
        playbackRevision &+= 1
        seekRevision &+= 1
        controlRevision &+= 1
        revokePlayingEvidence()
        resolveTimer?.cancel()
        resolveTimer = nil
        sourceTask?.cancel()
        sourceTask = nil
        pollTimer?.invalidate()
        pollTimer = nil
        pollBusy = false
        transportBusy = false
        transportStarted = false
        prepared = false
        deferredSeek = nil
        lastDevicePosition = 0
        endConsumed = false
        foreignMediaCount = 0
        pollFailures = 0
        mediaID = ""
        mediaURI = ""
        mediaServer?.invalidateRoutes()
        position = 0
        duration = 0
        if let path = relayTemporary { try? FileManager.default.removeItem(at: path); relayTemporary = nil }
    }

    private func load(_ selected: Int, _ start: Double, _ autoPlay: Bool, _ natural: Bool) {
        guard active, selected >= 0, selected < queue.count else { return }
        retireMedia()
        manuallyStopped = false
        index = selected
        mediaID = queue[selected].mediaId
        position = start
        duration = max(0, queue[selected].duration ?? 0)
        if !duration.isFinite { duration = 0 }
        intent = autoPlay
        phase = "preparing"
        error = ""
        let s = session, g = generation
        publish()
        guard matches(s, g) else { return }
        trackListener?(mediaID, natural)
        guard matches(s, g) else { return }
        let uri = queue[selected].uri
        if uri.hasPrefix("qt-resolve://") { requestResolve(false) }
        else { prepareSource(uri, "", s, g) }
    }

    private func requestResolve(_ refresh: Bool) {
        let s = session, g = generation
        let timer = DispatchWorkItem {
            guard self.matches(s, g) else { return }
            self.fail("投屏播放地址解析超时")
        }
        resolveTimer?.cancel()
        resolveTimer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: timer)
        resolveListener?(mediaID, String(g), refresh)
    }

    public func resolveDone(_ id: String, _ uri: String, _ referer: String, _ receipt: String) {
        mainValue {
            guard active, mediaID == id, UInt64(receipt) == generation, phase == "preparing" else { return }
            resolveTimer?.cancel()
            resolveTimer = nil
            prepareSource(uri, referer, session, generation)
        }
    }
    public func resolveFailed(_ id: String, _ receipt: String) {
        mainValue {
            guard active, mediaID == id, UInt64(receipt) == generation else { return }
            resolveTimer?.cancel()
            resolveTimer = nil
            fail("未能解析投屏播放地址")
        }
    }

    private func ensureServer(_ done: @escaping (Bool) -> Void) {
        if serverReady { done(true); return }
        serverWaiters.append(done)
        if serverStarting { return }
        guard let ip = QtIOSDLNAProtocol.wifiAddress() else {
            let waiters = serverWaiters; serverWaiters = []; waiters.forEach { $0(false) }; return
        }
        serverStarting = true
        serverAddress = ip
        serverRevision &+= 1
        let revision = serverRevision
        let server = QtIOSDLNAMediaServer()
        mediaServer = server
        server.start(ip) { success in
            guard self.serverRevision == revision else { return }
            self.serverStarting = false
            self.serverReady = success
            let waiters = self.serverWaiters
            self.serverWaiters = []
            waiters.forEach { $0(success) }
        }
    }

    private func prepareSource(_ text: String, _ referer: String, _ s: UInt64, _ g: UInt64) {
        guard matches(s, g), let url = text.hasPrefix("/") ? URL(fileURLWithPath: text) : URL(string: text),
              ["file", "http", "https"].contains(url.scheme?.lowercased() ?? "") else {
            if matches(s, g) { fail("投屏地址无效") }
            return
        }
        if url.isFileURL {
            guard let scope = QtIOSScopedFile.open(url) else { fail("无法读取此目录，请重新选择目录授权"); return }
            serveSource(scope, "", s, g)
            return
        }
        // Complete-file staging gives ordinary receivers truthful HEAD/Range
        // even when the source requires Referer, redirects or signed URLs.
        // No partial WAV/placeholder is ever substituted for the requested song.
        var request = URLRequest(url: url)
        request.timeoutInterval = 120
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if !referer.isEmpty, !referer.contains("\r"), !referer.contains("\n"),
           ["http", "https"].contains(URL(string: referer)?.scheme?.lowercased() ?? "") {
            request.setValue(referer, forHTTPHeaderField: "Referer")
        }
        sourceTask = network.downloadTask(with: request) { temporary, response, taskError in
            guard let temporary = temporary, let response = response as? HTTPURLResponse,
                  response.statusCode == 200,
                  let attrs = try? FileManager.default.attributesOfItem(atPath: temporary.path),
                  let bytes = attrs[.size] as? NSNumber, bytes.int64Value > 0,
                  bytes.int64Value <= 512 * 1024 * 1024,
                  response.expectedContentLength <= 0 || response.expectedContentLength == bytes.int64Value else {
                self.onMain {
                    if self.matches(s, g) { self.fail(taskError?.localizedDescription ?? "投屏歌曲下载失败或内容不完整") }
                }
                return
            }
            let mime = response.mimeType?.lowercased() ?? ""
            guard !mime.hasPrefix("text/"), !mime.contains("json"), !mime.contains("html"), !mime.contains("mpegurl") else {
                self.onMain { if self.matches(s, g) { self.fail("音源返回的内容不是完整音频文件") } }
                return
            }
            let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("qt-dlna", isDirectory: true)
            let destination = folder.appendingPathComponent("song-\(UUID().uuidString)")
            do {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                try FileManager.default.copyItem(at: temporary, to: destination)
            } catch {
                self.onMain { if self.matches(s, g) { self.fail("无法暂存投屏歌曲") } }
                return
            }
            self.onMain {
                guard self.matches(s, g) else { try? FileManager.default.removeItem(at: destination); return }
                self.sourceTask = nil
                self.relayTemporary = destination
                guard let scope = QtIOSScopedFile.open(destination) else { self.fail("投屏暂存文件不可读"); return }
                self.serveSource(scope, mime, s, g)
            }
        }
        sourceTask?.resume()
    }

    private func serveSource(_ scope: QtIOSScopedFile, _ suggestedMIME: String, _ s: UInt64, _ g: UInt64) {
        guard matches(s, g),
              let attrs = try? FileManager.default.attributesOfItem(atPath: scope.url.path),
              let bytes = attrs[.size] as? NSNumber, bytes.uint64Value > 0,
              let file = try? FileHandle(forReadingFrom: scope.url),
              let header = try? file.read(upToCount: 32) else { fail("投屏歌曲文件不可读"); return }
        try? file.close()
        let mime = QtIOSDLNAProtocol.mime(header, suggestedMIME)
        guard mime != "application/octet-stream" else { fail("无法识别投屏音频格式"); return }
        ensureServer { ready in
            guard self.matches(s, g) else { return }
            guard ready, let server = self.mediaServer else { self.fail("无法建立局域网媒体中继"); return }
            self.mediaURI = server.register(self.relayToken, g, scope, mime, bytes.uint64Value)
            self.setMediaURI(mime, bytes.uint64Value, s, g)
        }
    }

    private func setMediaURI(_ mime: String, _ bytes: UInt64, _ s: UInt64, _ g: UInt64) {
        guard let device = device, index >= 0, index < queue.count else { return }
        let track = queue[index]
        let escape = QtIOSDLNAProtocol.escape
        let length = duration > 0 ? " duration=\"\(QtIOSDLNAProtocol.time(duration))\"" : ""
        let metadata = "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\"><item id=\"0\" parentID=\"-1\" restricted=\"1\"><dc:title>\(escape(track.title))</dc:title><upnp:artist>\(escape(track.artist))</upnp:artist><upnp:album>\(escape(track.album))</upnp:album><upnp:class>object.item.audioItem.musicTrack</upnp:class><res protocolInfo=\"http-get:*:\(mime):DLNA.ORG_OP=01;DLNA.ORG_CI=0\" size=\"\(bytes)\"\(length)>\(escape(mediaURI))</res></item></DIDL-Lite>"
        enqueue(device.transport, "SetAVTransportURI",
                [("InstanceID", "0"), ("CurrentURI", mediaURI), ("CurrentURIMetaData", metadata)],
                valid: { self.matches(s, g) }) { success, _, detail in
            guard self.matches(s, g) else { return }
            if !success { self.fail("播放设备拒绝歌曲：\(detail)"); return }
            self.prepared = true
            if self.position > 0, device.canSeek {
                self.seekAfterPrepare(s, g)
            } else { self.driveTransport(); self.startPolling() }
        }
    }

    private func seekAfterPrepare(_ s: UInt64, _ g: UInt64) {
        guard let device = device else { return }
        // This also covers a deferred restore seek issued after the first Play.
        controlRevision &+= 1
        revokePlayingEvidence()
        let revision = seekRevision
        let playback = playbackRevision
        let control = controlRevision
        let target = position
        enqueue(device.transport, "Seek",
                [("InstanceID", "0"), ("Unit", "REL_TIME"), ("Target", QtIOSDLNAProtocol.time(target))],
                valid: { self.matches(s, g) && self.seekRevision == revision &&
                    self.playbackRevision == playback && self.controlRevision == control }) { success, _, detail in
            guard self.matches(s, g), self.seekRevision == revision,
                  self.playbackRevision == playback, self.controlRevision == control else {
                if self.matches(s, g) { self.driveTransport(); self.startPolling() }
                return
            }
            if !success {
                self.controlRevision &+= 1
                self.revokePlayingEvidence()
                self.error = "设备暂不接受跳转：\(detail)"
                if detail.contains("401") || detail.localizedCaseInsensitiveContains("invalid action") {
                    self.device?.actions.remove("Seek")
                    self.deferredSeek = nil
                    self.position = 0
                } else if !self.transportStarted {
                    // Some renderers cannot Seek until the first Play. Preserve
                    // the paused restore target and perform it after Play.
                    self.deferredSeek = target
                } else {
                    self.deferredSeek = nil
                    self.position = self.lastDevicePosition
                }
            } else if success && self.seekRevision == revision {
                self.deferredSeek = nil
                self.position = target
            }
            self.driveTransport()
            self.startPolling()
        }
    }

    public func play() {
        mainValue {
            guard active else { return }
            playbackRevision &+= 1
            controlRevision &+= 1
            revokePlayingEvidence()
            manuallyStopped = false
            intent = true
            if endConsumed && !queue.isEmpty { load(max(0, index), 0, true, false) }
            else if mediaID.isEmpty && !queue.isEmpty { load(max(0, index), position, true, false) }
            else { driveTransport() }
        }
    }
    public func pause() { mainValue { playbackRevision &+= 1; controlRevision &+= 1; revokePlayingEvidence(); intent = false; driveTransport(); publish() } }
    public func stop() {
        mainValue {
            guard active, let device = device else { return }
            retireMedia()
            manuallyStopped = true
            intent = false
            phase = "stopped"
            publish()
            enqueue(device.transport, "Stop", [("InstanceID", "0")], valid: { true }) { _, _, _ in }
        }
    }
    public func seek(_ seconds: String) {
        mainValue {
            guard active, device?.canSeek == true else { return }
            seekRevision &+= 1
            controlRevision &+= 1
            revokePlayingEvidence()
            position = max(0, number(seconds))
            if duration > 0 { position = min(position, duration) }
            if prepared { seekAfterPrepare(session, generation) }
            publish()
        }
    }
    public func setVolume(_ fraction: String) {
        mainValue {
            guard active, let device = device, device.canVolume, let rendering = device.rendering else { return }
            volumeRevision &+= 1
            let revision = volumeRevision, s = session
            let value = max(0, min(1, number(fraction, 1)))
            let raw = Int((device.minimumVolume + value * (device.maximumVolume - device.minimumVolume)).rounded())
            enqueue(rendering, "SetVolume",
                    [("InstanceID", "0"), ("Channel", "Master"), ("DesiredVolume", String(raw))],
                    valid: { self.active && self.session == s && self.volumeRevision == revision }) { success, _, detail in
                guard self.active, self.session == s, self.volumeRevision == revision else { return }
                if success { self.volume = value; self.error = "" }
                else {
                    self.error = "设备音量调节失败：\(detail)"
                    if detail.contains("401") || detail.localizedCaseInsensitiveContains("invalid action") {
                        self.device?.volumeActions.remove("SetVolume")
                    }
                }
                self.publish()
            }
        }
    }

    private func driveTransport() {
        guard active, prepared, !transportBusy, let device = device else { return }
        if !intent && !transportStarted { phase = "paused"; publish(); return }
        if (intent && phase == "playing" || !intent && phase == "paused") && transportStarted {
            publish()
            return
        }
        transportBusy = true
        let s = session, g = generation, revision = playbackRevision, desired = intent
        let action = desired ? "Play" : "Pause"
        let arguments = desired ? [("InstanceID", "0"), ("Speed", "1")] : [("InstanceID", "0")]
        enqueue(device.transport, action, arguments, valid: { self.matches(s, g) }) { success, _, detail in
            guard self.matches(s, g) else { return }
            self.transportBusy = false
            if success {
                self.transportStarted = self.transportStarted || desired
                // A successful earlier command changed the receiver even if a
                // newer intent arrived. Reconcile from that confirmed state;
                // keeping the older UI phase can incorrectly skip its Pause.
                self.phase = desired ? "playing" : "paused"
                if revision == self.playbackRevision {
                    self.error = ""
                    self.publish()
                    if desired, let target = self.deferredSeek {
                        self.position = target
                        self.seekAfterPrepare(s, g)
                    }
                }
            }
            if revision != self.playbackRevision { self.driveTransport() }
            else if !success { self.fail("投屏\(desired ? "播放" : "暂停")失败：\(detail)") }
        }
    }

    private func startPolling() {
        guard pollTimer == nil, active, prepared else { return }
        pollTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.poll() }
        poll()
    }

    private func poll() {
        guard active, prepared, !pollBusy, let device = device else { return }
        pollBusy = true
        pollSequence &+= 1
        let pollID = pollSequence
        let s = session, g = generation, playback = playbackRevision, seek = seekRevision, control = controlRevision
        enqueue(device.transport, "GetPositionInfo", [("InstanceID", "0")],
                valid: { self.matchesPoll(s, g, playback, seek, control, pollID) }) { success, root, _ in
            guard self.matchesPoll(s, g, playback, seek, control, pollID) else {
                self.finishPoll(s, g, pollID)
                return
            }
            guard success else {
                self.revokePlayingEvidence()
                self.finishPoll(s, g, pollID)
                self.pollFailures += 1
                if self.pollFailures == 3 { self.fail("无法读取播放设备状态，请检查局域网连接") }
                return
            }
            let sampledAt = ProcessInfo.processInfo.systemUptime
            let uri = root?.descendants("TrackURI").first?.text.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !uri.isEmpty && !self.uriMatchesMedia(uri) {
                self.revokePlayingEvidence()
                self.foreignMediaCount += 1
                self.finishPoll(s, g, pollID)
                if self.foreignMediaCount >= 2 { self.fail("播放设备已切换到其他媒体，请重新连接") }
                return
            }
            let rawPosition = self.deviceSeconds(root?.descendants("RelTime").first?.text ?? "")
            let rawDuration = self.deviceSeconds(root?.descendants("TrackDuration").first?.text ?? "")
            self.enqueue(device.transport, "GetTransportInfo", [("InstanceID", "0")],
                         valid: { self.matchesPoll(s, g, playback, seek, control, pollID) }) { success, info, _ in
                guard self.matchesPoll(s, g, playback, seek, control, pollID) else {
                    self.finishPoll(s, g, pollID)
                    return
                }
                guard success else {
                    self.revokePlayingEvidence()
                    self.finishPoll(s, g, pollID)
                    self.pollFailures += 1
                    if self.pollFailures == 3 { self.fail("无法读取播放设备状态，请检查局域网连接") }
                    return
                }
                // Commit position and phase together only after both SOAP replies
                // still belong to this session and its current controls.
                self.pollFailures = 0
                self.foreignMediaCount = 0
                if let rawDuration = rawDuration, rawDuration > 0 { self.duration = rawDuration }
                if let rawPosition = rawPosition {
                    self.lastDevicePosition = rawPosition
                    if self.deferredSeek == nil { self.position = rawPosition }
                }
                let currentPosition = rawPosition ?? 0
                let state = info?.descendants("CurrentTransportState").first?.text.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() ?? ""
                if state == "PLAYING" {
                    self.phase = "playing"
                    if !uri.isEmpty, let rawPosition = rawPosition, rawPosition > 0,
                       self.intent, !self.manuallyStopped, self.deferredSeek == nil {
                        self.lastConfirmedPlaying = PlayingEvidence(session: s, generation: g, playback: playback,
                            seek: seek, control: control, uri: uri, position: rawPosition, monotonic: sampledAt)
                    } else {
                        self.revokePlayingEvidence()
                    }
                } else if state == "PAUSED_PLAYBACK" {
                    self.revokePlayingEvidence()
                    self.phase = "paused"
                } else if state == "TRANSITIONING" {
                    self.revokePlayingEvidence()
                    self.phase = "buffering"
                } else if state == "STOPPED" || state == "NO_MEDIA_PRESENT" {
                    let evidence = self.lastConfirmedPlaying
                    self.revokePlayingEvidence()
                    if self.intent, !self.manuallyStopped, self.duration > 2,
                       let evidence = evidence,
                       evidence.session == s, evidence.generation == g, evidence.playback == playback,
                       evidence.seek == seek, evidence.control == control,
                       self.uriMatchesMedia(evidence.uri),
                       (uri.isEmpty || self.uriMatchesMedia(uri)) {
                        let elapsed = ProcessInfo.processInfo.systemUptime - evidence.monotonic
                        if elapsed >= 0, elapsed <= 5 {
                            let candidate = min(self.duration, max(evidence.position + elapsed, currentPosition))
                            if self.duration - candidate <= 1.8 {
                                self.finishPoll(s, g, pollID)
                                self.advanceNatural()
                                return
                            }
                        }
                    }
                    self.phase = "stopped"
                } else {
                    self.revokePlayingEvidence()
                    self.phase = "connected"
                }
                self.finishPoll(s, g, pollID)
                self.publish()
            }
        }
    }

    private func advanceNatural() {
        guard !endConsumed else { return }
        endConsumed = true
        revokePlayingEvidence()
        if repeatMode == 1 { load(index, 0, true, true); return }
        if index + 1 < queue.count { load(index + 1, 0, true, true); return }
        if repeatMode == 2 && !queue.isEmpty { load(0, 0, true, true); return }
        intent = false
        phase = "stopped"
        pollTimer?.invalidate()
        pollTimer = nil
        publish()
        QtIOSAudio.shared.reportRemoteEnded()
    }

    public func disconnect(_ callback: @escaping (Bool) -> Void) {
        mainValue {
            guard active, let previous = device else { callback(false); return }
            retireMedia()
            session &+= 1
            active = false
            intent = false
            phase = "idle"
            error = ""
            QtIOSAudio.shared.clearRemote()
            publish()
            enqueue(previous.transport, "Stop", [("InstanceID", "0")], valid: { true }) { success, _, _ in
                if !self.active {
                    self.serverRevision &+= 1
                    self.mediaServer?.stop()
                    self.mediaServer = nil
                    self.serverReady = false
                    self.serverStarting = false
                    let waiters = self.serverWaiters
                    self.serverWaiters = []
                    waiters.forEach { $0(false) }
                }
                callback(success)
            }
        }
    }

    public func invalidateSourcePolicy() {
        mainValue {
            if active, phase == "preparing", !mediaID.isEmpty, index >= 0, index < queue.count,
               queue[index].uri.hasPrefix("qt-resolve://") {
                load(index, position, intent, false)
            }
        }
    }

    private func enqueue(_ service: QtIOSDLNAService, _ action: String, _ arguments: [(String, String)],
                         valid: @escaping () -> Bool, _ completion: @escaping (Bool, QtIOSXMLNode?, String) -> Void) {
        jobs.append(SOAPJob(service: service, action: action, arguments: arguments, valid: valid, completion: completion))
        pumpSOAP()
    }

    private func pumpSOAP() {
        if soapBusy || jobs.isEmpty { return }
        let job = jobs.removeFirst()
        if !job.valid() { job.completion(false, nil, "操作已过期"); pumpSOAP(); return }
        soapBusy = true
        let fields = job.arguments.map { "<\($0.0)>\(QtIOSDLNAProtocol.escape($0.1))</\($0.0)>" }.joined()
        let body = "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:\(job.action) xmlns:u=\"\(job.service.type)\">\(fields)</u:\(job.action)></s:Body></s:Envelope>"
        var request = URLRequest(url: job.service.control)
        request.httpMethod = "POST"
        request.timeoutInterval = 8
        request.setValue("text/xml; charset=\"utf-8\"", forHTTPHeaderField: "Content-Type")
        request.setValue("\"\(job.service.type)#\(job.action)\"", forHTTPHeaderField: "SOAPAction")
        request.httpBody = Data(body.utf8)
        network.dataTask(with: request) { data, response, taskError in
            let root = data.flatMap(QtIOSXMLParser.parse)
            let code = root?.descendants("errorCode").first?.text ?? ""
            let description = root?.descendants("errorDescription").first?.text ?? ""
            let fault = code.isEmpty ? description : "\(code) \(description)"
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let success = (200..<300).contains(status) && root != nil && root?.descendants("Fault").isEmpty == true
            self.onMain {
                self.soapBusy = false
                job.completion(success, root, taskError?.localizedDescription ?? (fault.isEmpty ? "HTTP \(status)" : fault))
                self.pumpSOAP()
            }
        }.resume()
    }
}
