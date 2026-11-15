import Foundation
import AVFoundation
import MediaPlayer
import UIKit
import UserNotifications

/// Native state stays on the main queue. The UTS facade exchanges strings and
/// booleans so its generated NSNumber/UTSArray types do not leak into this file.
public final class QtIOSAudio: NSObject {
    public static let shared = QtIOSAudio()
    public typealias EventListener = (String, String, String, String, Bool) -> Void

    private struct Track: Codable {
        var mediaId: String
        var uri: String
        var title: String
        var artist: String
        var album: String
        var coverUrl: String
        var duration: Double?
    }

    private struct CacheEntry: Codable {
        var file: String
        var bytes: Int64
        var touched: Double
        var mediaId: String?
    }

    private struct Resolved {
        let uri: String
        let at: TimeInterval
    }

    private struct Pending {
        let epoch: UInt64
        let policy: UInt64
        let sourceKey: String
        let preload: Bool
        let timer: DispatchWorkItem
    }

    private let player = AVPlayer()
    private var listener: EventListener?
    private var remoteCommandListener: ((String, String) -> Void)?
    private var items: [Track] = []
    private var index = -1
    private var loadedID = ""
    private var legacySource = ""
    private var legacyTitle = ""
    private var legacyArtist = ""
    private var legacyAlbum = ""
    private var legacyCover = ""
    private var repeatMode = 0
    private var intending = false
    private var interrupted = false
    private var remoteOwned = false
    private var remotePosition = 0.0
    private var remoteDuration = 0.0
    private var remoteCanSeek = false
    private var remotePhase = ""
    private var pendingPosition = 0.0
    private var speed: Float = 1
    private var volume: Float = 1
    private var concurrentMode = 0
    private var epoch: UInt64 = 0
    private var statusObservation: NSKeyValueObservation?
    private var controlObservation: NSKeyValueObservation?
    private var endObserver: NSObjectProtocol?
    private var failedObserver: NSObjectProtocol?
    private var systemObservers: [NSObjectProtocol] = []
    private var timeObserver: Any?
    private var commandTargets: [(MPRemoteCommand, Any)] = []
    private var lastPlaying: Bool?
    private var lastWaiting = false
    private var ready = false
    private var dspSupported = true
    private var artwork: MPMediaItemArtwork?
    private var coverTask: URLSessionDataTask?
    private var artworkEpoch: UInt64 = 0
    private var likedIDs = Set<String>()
    private var resolved: [String: Resolved] = [:]
    private var referers: [String: String] = [:]
    private var httpLoader: QtIOSHTTPAudioLoader?
    private var pending: [String: Pending] = [:]
    private var cache: [String: CacheEntry] = [:]
    private var downloads: [String: URLSessionDownloadTask] = [:]
    private var downloadTokens: [String: UInt64] = [:]
    private var downloadRevision: UInt64 = 0
    private var cacheEpoch: UInt64 = 0
    private var sourcePolicy: UInt64 = 0
    private var cacheLimit: Int64 = 1024 * 1024 * 1024
    private var pinnedCacheFile = ""
    private var scopedPlayback: QtIOSScopedFile?
    private var deferredCacheFiles = Set<String>()
    private let files = FileManager.default
    private let cacheDirectory: URL
    private let network = URLSession(configuration: .default)

    private override init() {
        cacheDirectory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("qt-audio", isDirectory: true)
        super.init()
        try? files.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
        restoreCache()
        player.automaticallyWaitsToMinimizeStalling = true
        controlObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            self?.onMain { self?.publishControlState() }
        }
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.2, preferredTimescale: 600), queue: .main
        ) { [weak self] _ in
            guard let self = self, !self.remoteOwned, !self.loadedID.isEmpty else { return }
            self.emit("timeupdate", self.loadedID, self.position(), self.duration())
            self.publishNowPlaying()
        }
        installSystemObservers()
        onMain { self.installCommands() }
    }

    private func onMain(_ action: @escaping () -> Void) {
        if Thread.isMainThread { action() } else { DispatchQueue.main.async(execute: action) }
    }

    private func mainValue<T>(_ action: () -> T) -> T {
        if Thread.isMainThread { return action() }
        return DispatchQueue.main.sync(execute: action)
    }

    private func emit(_ event: String, _ mediaID: String = "", _ value: Double = 0,
                      _ extra: Double = 0, _ flag: Bool = false) {
        listener?(event, mediaID, String(value), String(extra), flag)
    }

    private func finite(_ text: String, _ fallback: Double = 0) -> Double {
        guard let n = Double(text), n.isFinite else { return fallback }
        return n
    }

    private func currentTrack() -> Track? {
        guard index >= 0, index < items.count else { return nil }
        return items[index]
    }

    private func position() -> Double {
        if remoteOwned { return remotePosition }
        let value = player.currentTime().seconds
        return value.isFinite && value >= 0 ? value : pendingPosition
    }

    private func duration() -> Double {
        if remoteOwned { return remoteDuration }
        let actual = player.currentItem?.duration.seconds ?? 0
        if actual.isFinite && actual > 0 { return actual }
        let declared = currentTrack()?.duration ?? 0
        return declared.isFinite && declared > 0 ? declared : 0
    }

    public func setEventListener(_ callback: @escaping EventListener) {
        mainValue { listener = callback }
    }

    /// The DLNA controller installs this separately; local queue callbacks never
    /// decode a local item while a remote renderer owns playback.
    public func setRemoteCommandListener(_ callback: @escaping (String, String) -> Void) {
        mainValue { remoteCommandListener = callback }
    }

    public func currentTime() -> String { mainValue { String(position()) } }
    public func monotonicTime() -> String { String(ProcessInfo.processInfo.systemUptime * 1000) }
    public func currentMediaID() -> String { mainValue { loadedID } }
    public func timelineSize() -> String { mainValue { String(items.count) } }
    public func currentTimelineIndex() -> String { mainValue { String(index) } }
    public func isIntendingToPlay() -> Bool { mainValue { intending } }

    public func setPlaylist(_ json: String, _ start: String, _ autoPlay: Bool, _ position: String) {
        mainValue {
            guard let data = json.data(using: .utf8),
                  let tracks = try? JSONDecoder().decode([Track].self, from: data),
                  tracks.allSatisfy({ !$0.mediaId.isEmpty && !$0.uri.isEmpty }) else {
                emitError("播放队列数据无效")
                return
            }
            if remoteOwned { return }
            items = tracks
            resolved.removeAll()
            cancelPending()
            if items.isEmpty { stopLocal(clearQueue: true); return }
            let selected = Int(max(0, min(Double(items.count - 1), finite(start))))
            load(selected, max(0, finite(position)), autoPlay, naturalEnd: false)
        }
    }

    public func syncTimeline(_ json: String, _ expectedID: String) {
        mainValue {
            guard !expectedID.isEmpty, loadedID == expectedID,
                  let data = json.data(using: .utf8),
                  let tracks = try? JSONDecoder().decode([Track].self, from: data),
                  tracks.allSatisfy({ !$0.mediaId.isEmpty && !$0.uri.isEmpty }),
                  let selected = QtIOSAudioOccurrence.index(items.map { $0.mediaId }, index,
                                                            tracks.map { $0.mediaId }, expectedID) else { return }
            items = tracks
            index = selected
            publishNowPlaying()
            updateCommands()
        }
    }

    public func playTimelineIndex(_ selected: String) {
        mainValue {
            guard !remoteOwned else { return }
            let value = finite(selected, -1)
            guard value >= 0, value < Double(items.count) else { return }
            load(Int(value), 0, true, naturalEnd: false)
        }
    }

    public func setRepeatMode(_ mode: String) {
        mainValue { repeatMode = Int(max(0, min(2, finite(mode)))); updateCommands() }
    }

    private func load(_ selected: Int, _ start: Double, _ autoPlay: Bool, naturalEnd: Bool) {
        guard !remoteOwned, selected >= 0, selected < items.count else { return }
        retireItem()
        index = selected
        loadedID = items[selected].mediaId
        pendingPosition = start
        intending = autoPlay
        interrupted = false
        ready = false
        lastWaiting = false
        artwork = nil
        requestArtwork(items[selected].coverUrl)
        publishNowPlaying()
        updateCommands()
        let requestEpoch = epoch
        let mediaID = loadedID
        emit("trackchanged", mediaID, 0, 0, naturalEnd)
        // JS callbacks may synchronously change the timeline or stop playback.
        guard epoch == requestEpoch, loadedID == mediaID, !remoteOwned else { return }
        emitWaiting()
        if let cached = cachedURL(items[selected].uri) {
            prepare(cached, requestEpoch)
        } else if let uri = resolvedURI(items[selected]) {
            prepare(uri, requestEpoch)
        } else {
            requestResolve(mediaID, items[selected].uri, preload: false)
        }
    }

    private func resolvedURI(_ item: Track) -> URL? {
        if !item.uri.hasPrefix("qt-resolve://") { return mediaURL(item.uri) }
        if let hit = resolved[item.uri],
           ProcessInfo.processInfo.systemUptime - hit.at < 240 { return mediaURL(hit.uri) }
        return nil
    }

    private func mediaURL(_ text: String) -> URL? {
        if text.hasPrefix("/") { return URL(fileURLWithPath: text) }
        guard let url = URL(string: text),
              let scheme = url.scheme?.lowercased(),
              ["file", "http", "https"].contains(scheme) else { return nil }
        return url
    }

    private func requestResolve(_ mediaID: String, _ sourceKey: String, preload: Bool) {
        // A foreground load supersedes a prefetch for the same media ID.
        if let existing = pending[mediaID] {
            if preload || !existing.preload { return }
            existing.timer.cancel()
        }
        let requestEpoch = epoch
        let policy = sourcePolicy
        let timer = DispatchWorkItem { [weak self] in
            guard let self = self, let request = self.pending[mediaID],
                  request.epoch == requestEpoch, request.policy == policy,
                  request.preload == preload else { return }
            self.pending.removeValue(forKey: mediaID)
            if request.policy != self.sourcePolicy {
                self.retryInvalidatedResolve(mediaID, request)
                return
            }
            if !preload && self.epoch == requestEpoch && self.loadedID == mediaID && !self.remoteOwned {
                self.emitError("播放地址解析超时")
            }
        }
        pending[mediaID] = Pending(epoch: requestEpoch, policy: policy, sourceKey: sourceKey, preload: preload, timer: timer)
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: timer)
        emit("resolve", mediaID)
    }

    public func resolveDone(_ mediaID: String, _ uri: String) {
        mainValue {
            guard let request = pending.removeValue(forKey: mediaID) else { return }
            request.timer.cancel()
            guard request.policy == sourcePolicy else {
                retryInvalidatedResolve(mediaID, request)
                return
            }
            guard let url = mediaURL(uri) else {
                if !request.preload && !remoteOwned && request.epoch == epoch && loadedID == mediaID {
                    emitError("音源返回了无效的播放地址")
                }
                return
            }
            resolved[request.sourceKey] = Resolved(uri: uri, at: ProcessInfo.processInfo.systemUptime)
            if request.preload { beginPreload(mediaID, request.sourceKey, url); return }
            guard !remoteOwned, request.epoch == epoch, loadedID == mediaID else { return }
            if let item = currentTrack(), item.uri != request.sourceKey {
                requestResolve(mediaID, item.uri, preload: false)
                return
            }
            prepare(url, request.epoch)
        }
    }

    public func resolveFailed(_ mediaID: String) {
        mainValue {
            guard let request = pending.removeValue(forKey: mediaID) else { return }
            request.timer.cancel()
            guard request.policy == sourcePolicy else {
                retryInvalidatedResolve(mediaID, request)
                return
            }
            if !request.preload && !remoteOwned && request.epoch == epoch && loadedID == mediaID {
                emitError("未能解析歌曲播放地址")
            }
        }
    }

    private func retryInvalidatedResolve(_ mediaID: String, _ request: Pending) {
        guard !request.preload, !remoteOwned, request.epoch == epoch, loadedID == mediaID,
              player.currentItem == nil, let item = currentTrack() else { return }
        requestResolve(mediaID, item.uri, preload: false)
    }

    public func setResolveReferer(_ mediaID: String, _ referer: String) {
        mainValue {
            if referer.isEmpty || referer.contains("\r") || referer.contains("\n")
                || !["http", "https"].contains(URL(string: referer)?.scheme?.lowercased() ?? "") {
                referers.removeValue(forKey: mediaID)
            }
            else { referers[mediaID] = referer }
        }
    }

    private func prepare(_ url: URL, _ requestEpoch: UInt64) {
        guard !remoteOwned, epoch == requestEpoch, !loadedID.isEmpty else { return }
        let source: URL
        if url.isFileURL {
            guard let scope = QtIOSScopedFile.open(url) else {
                emitError("无法读取此目录，请重新选择目录授权")
                return
            }
            scopedPlayback = scope
            source = scope.url
        } else { source = url }
        let item: AVPlayerItem
        if !source.isFileURL, let referer = referers[loadedID], !referer.isEmpty {
            let loader = QtIOSHTTPAudioLoader(source, referer)
            httpLoader = loader
            let assetURL = URL(string: "qt-audio://media/\(UUID().uuidString).\(source.pathExtension)")!
            let asset = AVURLAsset(url: assetURL)
            asset.resourceLoader.setDelegate(loader, queue: .main)
            item = AVPlayerItem(asset: asset)
        } else { item = AVPlayerItem(url: source) }
        item.audioTimePitchAlgorithm = .timeDomain
        statusObservation = item.observe(\.status, options: [.initial, .new]) { [weak self, weak item] _, _ in
            self?.onMain {
                guard let self = self, let item = item, !self.remoteOwned,
                      self.epoch == requestEpoch, self.player.currentItem === item else { return }
                if item.status == .failed {
                    self.emitError(item.error?.localizedDescription ?? "音频加载失败")
                } else if item.status == .readyToPlay {
                    self.onReady(item, requestEpoch)
                }
            }
        }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
        ) { [weak self, weak item] _ in
            guard let self = self, let item = item, !self.remoteOwned, self.intending,
                  self.epoch == requestEpoch, self.player.currentItem === item else { return }
            self.naturalEnd()
        }
        failedObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main
        ) { [weak self, weak item] note in
            guard let self = self, let item = item, !self.remoteOwned,
                  self.epoch == requestEpoch, self.player.currentItem === item else { return }
            let error = note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
            self.emitError(error?.localizedDescription ?? "音频流意外中断")
        }
        player.replaceCurrentItem(with: item)
        player.volume = volume
        // The initial KVO callback can precede replaceCurrentItem.
        if item.status == .readyToPlay { onReady(item, requestEpoch) }
        applyTransport()
    }

    private func onReady(_ item: AVPlayerItem, _ requestEpoch: UInt64) {
        guard !ready else { return }
        ready = true
        QtIOSAudioDSP.install(item, { [weak self, weak item] in
            guard let self = self, let item = item else { return false }
            return !self.remoteOwned && self.epoch == requestEpoch && self.player.currentItem === item
        }, { [weak self] supported in self?.dspSupported = supported })
        let target = pendingPosition
        let seekRevision = epoch
        let finish: (Bool) -> Void = { [weak self, weak item] _ in
            self?.onMain {
                guard let self = self, let item = item, !self.remoteOwned,
                      self.epoch == requestEpoch, self.epoch == seekRevision,
                      self.player.currentItem === item else { return }
                self.emit("canplay", self.loadedID)
                self.lastWaiting = false
                // Read the current intention; pausing during URL/asset loading
                // must not be undone by the completion of an earlier Play.
                self.applyTransport()
                self.emit("timeupdate", self.loadedID, self.position(), self.duration())
                self.publishNowPlaying()
            }
        }
        if target > 0 {
            player.seek(to: CMTime(seconds: target, preferredTimescale: 600),
                        toleranceBefore: .zero, toleranceAfter: .zero, completionHandler: finish)
        } else { finish(true) }
    }

    private func naturalEnd() {
        guard !remoteOwned else { return }
        if repeatMode == 1 { load(index, 0, true, naturalEnd: true); return }
        let selected = index + 1
        if selected < items.count { load(selected, 0, true, naturalEnd: true); return }
        if repeatMode == 2 && !items.isEmpty { load(0, 0, true, naturalEnd: true); return }
        intending = false
        lastPlaying = false
        publishNowPlaying()
        emit("ended", loadedID)
    }

    private func cancelPending() {
        for request in pending.values { request.timer.cancel() }
        pending.removeAll()
    }

    private func retireItem() {
        epoch &+= 1
        statusObservation = nil
        if let observer = endObserver { NotificationCenter.default.removeObserver(observer) }
        if let observer = failedObserver { NotificationCenter.default.removeObserver(observer) }
        endObserver = nil
        failedObserver = nil
        for (mediaID, request) in pending where !request.preload {
            request.timer.cancel()
            pending.removeValue(forKey: mediaID)
        }
        player.pause()
        player.replaceCurrentItem(with: nil)
        httpLoader?.cancel()
        httpLoader = nil
        scopedPlayback = nil
        if !pinnedCacheFile.isEmpty, deferredCacheFiles.remove(pinnedCacheFile) != nil {
            try? files.removeItem(at: cacheDirectory.appendingPathComponent(pinnedCacheFile))
        }
        pinnedCacheFile = ""
        ready = false
    }

    public func play() {
        mainValue {
            if remoteOwned { remoteCommandListener?("play", ""); return }
            intending = true
            if player.currentItem != nil || pending.values.contains(where: { !$0.preload }) {
                applyTransport()
                return
            }
            if !items.isEmpty {
                load(max(0, min(items.count - 1, index)), pendingPosition, true, naturalEnd: false)
            } else if !legacySource.isEmpty {
                items = [Track(mediaId: legacySource, uri: legacySource, title: legacyTitle,
                               artist: legacyArtist, album: legacyAlbum, coverUrl: legacyCover, duration: nil)]
                load(0, pendingPosition, true, naturalEnd: false)
            } else { intending = false }
        }
    }

    public func pause() {
        mainValue {
            if remoteOwned { remoteCommandListener?("pause", ""); return }
            intending = false
            interrupted = false
            player.pause()
            publishPlaying(false)
            publishNowPlaying()
        }
    }

    public func stop() {
        mainValue {
            if remoteOwned { remoteCommandListener?("stop", ""); return }
            stopLocal(clearQueue: false)
        }
    }

    private func stopLocal(clearQueue: Bool) {
        intending = false
        interrupted = false
        retireItem()
        cancelPending()
        pendingPosition = 0
        loadedID = ""
        lastPlaying = false
        lastWaiting = false
        if clearQueue { items = []; index = -1 }
        coverTask?.cancel()
        artworkEpoch &+= 1
        artwork = nil
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        updateCommands()
        emit("stop")
    }

    public func seek(_ seconds: String) {
        mainValue {
            let target = max(0, finite(seconds))
            if remoteOwned {
                if remoteCanSeek { remoteCommandListener?("seek", String(target)) }
                return
            }
            pendingPosition = duration() > 0 ? min(target, duration()) : target
            guard player.currentItem != nil, ready else { return }
            let requestEpoch = epoch
            player.seek(to: CMTime(seconds: pendingPosition, preferredTimescale: 600),
                        toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
                self?.onMain {
                    guard let self = self, self.epoch == requestEpoch, !self.remoteOwned else { return }
                    self.emit("timeupdate", self.loadedID, self.position(), self.duration())
                    self.publishNowPlaying()
                }
            }
        }
    }

    public func next() { mainValue { move(1) } }
    public func previous() { mainValue { move(-1) } }

    private func move(_ offset: Int) {
        guard !remoteOwned, !items.isEmpty else { return }
        var selected = index + offset
        if selected < 0 || selected >= items.count {
            guard repeatMode == 2 else { return }
            selected = (selected + items.count) % items.count
        }
        load(selected, 0, true, naturalEnd: false)
    }

    public func setSource(_ uri: String) { mainValue { legacySource = uri } }
    public func setTitle(_ value: String) { mainValue { legacyTitle = value; updateCurrentMetadata(title: value) } }
    public func setArtist(_ value: String) { mainValue { legacyArtist = value; updateCurrentMetadata(artist: value) } }
    public func setAlbum(_ value: String) { mainValue { legacyAlbum = value; updateCurrentMetadata(album: value) } }
    public func setCover(_ value: String) {
        mainValue { legacyCover = value; setTrackCover(loadedID, value) }
    }

    private func updateCurrentMetadata(title: String? = nil, artist: String? = nil, album: String? = nil) {
        guard index >= 0, index < items.count else { return }
        if let title = title { items[index].title = title }
        if let artist = artist { items[index].artist = artist }
        if let album = album { items[index].album = album }
        publishNowPlaying()
    }

    public func setTrackCover(_ mediaID: String, _ cover: String) {
        mainValue {
            guard !mediaID.isEmpty else { return }
            for selected in items.indices where items[selected].mediaId == mediaID {
                items[selected].coverUrl = cover
            }
            if loadedID == mediaID { requestArtwork(cover); publishNowPlaying() }
        }
    }

    public func setSpeed(_ value: String) {
        mainValue { speed = Float(max(0.5, min(3, finite(value, 1)))); applyTransport() }
    }

    public func setVolume(_ value: String) {
        mainValue {
            volume = Float(max(0, min(1, finite(value, 1))))
            if remoteOwned { remoteCommandListener?("volume", String(volume)); return }
            player.volume = volume
        }
    }

    public func setConcurrentMode(_ value: String) {
        mainValue {
            concurrentMode = Int(max(0, min(2, finite(value))))
            if intending && !remoteOwned { activateSession(); applyTransport() }
        }
    }

    public func effectsSupported() -> Bool { mainValue { !remoteOwned && dspSupported } }
    public func setEqualizerEnabled(_ enabled: Bool) { QtIOSAudioDSP.shared.setEqualizer(enabled) }
    public func setEqualizerBands(_ json: String) { QtIOSAudioDSP.shared.setBands(json) }
    public func setEnhanceEnabled(_ enabled: Bool) { QtIOSAudioDSP.shared.setEnhance(enabled) }
    public func setEnhanceGain(_ value: String) { QtIOSAudioDSP.shared.setGain(value) }

    @discardableResult private func activateSession() -> Bool {
        let session = AVAudioSession.sharedInstance()
        let options: AVAudioSession.CategoryOptions = concurrentMode == 2 ? [.mixWithOthers]
            : concurrentMode == 1 ? [.mixWithOthers, .duckOthers] : []
        do {
            try session.setCategory(.playback, mode: .default, options: options)
            try session.setActive(true)
            return true
        } catch {
            emitError("系统音频会话不可用：\(error.localizedDescription)")
            return false
        }
    }

    private func applyTransport() {
        guard !remoteOwned else { publishNowPlaying(); return }
        if intending && !interrupted {
            guard activateSession() else { return }
            player.rate = speed
        } else { player.pause() }
        publishControlState()
        publishNowPlaying()
    }

    private func emitWaiting() {
        guard !lastWaiting else { return }
        lastWaiting = true
        emit("waiting", loadedID)
    }

    private func publishPlaying(_ playing: Bool) {
        guard lastPlaying != playing else { return }
        lastPlaying = playing
        emit(playing ? "play" : "pause", loadedID)
    }

    private func publishControlState() {
        guard !remoteOwned, !loadedID.isEmpty else { return }
        switch player.timeControlStatus {
        case .playing:
            if lastWaiting { lastWaiting = false; emit("canplay", loadedID) }
            publishPlaying(true)
        case .waitingToPlayAtSpecifiedRate:
            if intending { emitWaiting() }
        case .paused:
            if !intending || interrupted { publishPlaying(false) }
        @unknown default:
            break
        }
    }

    private func emitError(_ message: String) {
        intending = false
        interrupted = false
        player.pause()
        lastWaiting = false
        publishPlaying(false)
        publishNowPlaying()
        listener?("error", loadedID, message, "", false)
    }

    private func installSystemObservers() {
        let center = NotificationCenter.default
        systemObservers.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let self = self, !self.remoteOwned,
                  let value = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let kind = AVAudioSession.InterruptionType(rawValue: value) else { return }
            if kind == .began {
                self.interrupted = self.intending
                self.player.pause()
                self.publishPlaying(false)
                self.publishNowPlaying()
            } else {
                let raw = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
                let shouldResume = AVAudioSession.InterruptionOptions(rawValue: raw).contains(.shouldResume)
                let resume = self.interrupted && self.intending && shouldResume
                self.interrupted = false
                if resume { self.applyTransport() }
                else { self.intending = false; self.publishNowPlaying() }
            }
        })
        systemObservers.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let self = self, !self.remoteOwned,
                  let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue else { return }
            self.pause()
        })
        systemObservers.append(center.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self = self, !self.remoteOwned, !self.items.isEmpty else { return }
            let start = self.position()
            let autoPlay = self.intending
            self.load(max(0, self.index), start, autoPlay, naturalEnd: false)
        })
    }

    private func addCommand(_ command: MPRemoteCommand, _ name: String) {
        let token = command.addTarget { [weak self] event in
            guard let self = self else { return .commandFailed }
            return self.mainValue {
                guard !self.loadedID.isEmpty || !self.items.isEmpty else { return .noSuchContent }
                if name == "rating" {
                    let liked = !((event.command as? MPFeedbackCommand)?.isActive ?? false)
                    self.emit("rating", self.loadedID, 0, 0, liked)
                } else if self.remoteOwned {
                    var value = ""
                    if let seek = event as? MPChangePlaybackPositionCommandEvent { value = String(seek.positionTime) }
                    self.remoteCommandListener?(name, value)
                } else {
                    switch name {
                    case "play": self.play()
                    case "pause": self.pause()
                    case "toggle": if self.intending { self.pause() } else { self.play() }
                    case "stop": self.stop()
                    case "next": self.emit("next", self.loadedID)
                    case "prev": self.emit("prev", self.loadedID)
                    case "seek":
                        if let seek = event as? MPChangePlaybackPositionCommandEvent { self.seek(String(seek.positionTime)) }
                    case "speed":
                        if let rate = event as? MPChangePlaybackRateCommandEvent { self.setSpeed(String(rate.playbackRate)) }
                    default: return .commandFailed
                    }
                }
                return .success
            }
        }
        commandTargets.append((command, token))
    }

    private func installCommands() {
        let center = MPRemoteCommandCenter.shared()
        let commands: [(MPRemoteCommand, String)] = [
            (center.playCommand, "play"), (center.pauseCommand, "pause"),
            (center.togglePlayPauseCommand, "toggle"), (center.stopCommand, "stop"),
            (center.nextTrackCommand, "next"), (center.previousTrackCommand, "prev"),
            (center.changePlaybackPositionCommand, "seek"), (center.changePlaybackRateCommand, "speed"),
            (center.likeCommand, "rating")
        ]
        for (command, name) in commands { addCommand(command, name) }
        center.changePlaybackRateCommand.supportedPlaybackRates = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]
        UIApplication.shared.beginReceivingRemoteControlEvents()
        updateCommands()
    }

    private func updateCommands() {
        let center = MPRemoteCommandCenter.shared()
        let hasContent = !loadedID.isEmpty || !items.isEmpty
        center.playCommand.isEnabled = hasContent
        center.pauseCommand.isEnabled = hasContent
        center.stopCommand.isEnabled = hasContent
        center.togglePlayPauseCommand.isEnabled = hasContent
        center.nextTrackCommand.isEnabled = !items.isEmpty && (repeatMode == 2 || index + 1 < items.count)
        center.previousTrackCommand.isEnabled = !items.isEmpty && (repeatMode == 2 || index > 0)
        center.changePlaybackPositionCommand.isEnabled = hasContent && (!remoteOwned || remoteCanSeek)
        center.changePlaybackRateCommand.isEnabled = hasContent && !remoteOwned
        center.likeCommand.isEnabled = !loadedID.isEmpty
        center.likeCommand.isActive = likedIDs.contains(loadedID)
        center.likeCommand.localizedTitle = center.likeCommand.isActive ? "取消收藏" : "收藏"
    }

    public func setLiked(_ mediaID: String, _ liked: Bool) {
        mainValue {
            if liked { likedIDs.insert(mediaID) } else { likedIDs.remove(mediaID) }
            updateCommands()
        }
    }

    private func publishNowPlaying() {
        guard !loadedID.isEmpty else { return }
        let track = currentTrack()
        let playing = remoteOwned ? remotePhase == "playing"
            : intending && !interrupted && player.timeControlStatus == .playing
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: track?.title ?? legacyTitle,
            MPMediaItemPropertyArtist: track?.artist ?? legacyArtist,
            MPMediaItemPropertyAlbumTitle: track?.album ?? legacyAlbum,
            MPNowPlayingInfoPropertyExternalContentIdentifier: loadedID,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position(),
            MPNowPlayingInfoPropertyPlaybackRate: playing ? (remoteOwned ? 1.0 : Double(speed)) : 0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: remoteOwned ? 1.0 : Double(speed),
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
            MPNowPlayingInfoPropertyIsLiveStream: duration() <= 0
        ]
        if duration() > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration() }
        if index >= 0 {
            info[MPNowPlayingInfoPropertyPlaybackQueueIndex] = index
            info[MPNowPlayingInfoPropertyPlaybackQueueCount] = items.count
        }
        if let artwork = artwork { info[MPMediaItemPropertyArtwork] = artwork }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func requestArtwork(_ uri: String) {
        coverTask?.cancel()
        artworkEpoch &+= 1
        let requestEpoch = artworkEpoch
        artwork = nil
        guard !uri.isEmpty, let url = mediaURL(uri) else { return }
        let adopt: (Data?) -> Void = { [weak self] data in
            self?.onMain {
                guard let self = self, self.artworkEpoch == requestEpoch,
                      !self.loadedID.isEmpty, let data = data, data.count <= 8 * 1024 * 1024,
                      let image = UIImage(data: data) else { return }
                self.artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                self.publishNowPlaying()
            }
        }
        if url.isFileURL {
            guard let scope = QtIOSScopedFile.open(url) else { return }
            DispatchQueue.global(qos: .utility).async { adopt(try? Data(contentsOf: scope.url)) }
        } else {
            var request = URLRequest(url: url)
            request.timeoutInterval = 15
            coverTask = network.dataTask(with: request) { data, response, _ in
                guard let response = response as? HTTPURLResponse,
                      (200..<300).contains(response.statusCode) else { return }
                adopt(data)
            }
            coverTask?.resume()
        }
    }

    /// Called only after the controller has chosen a valid renderer.
    public func suspendForRemote() {
        mainValue {
            remotePosition = position()
            remoteDuration = duration()
            remoteOwned = true
            remotePhase = "connecting"
            retireItem()
            publishNowPlaying()
        }
    }

    public func publishRemote(_ json: String, _ playIntent: Bool) {
        mainValue {
            guard remoteOwned, let data = json.data(using: .utf8),
                  let state = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
            let mediaID = state["mediaId"] as? String ?? ""
            let changed = loadedID != mediaID
            loadedID = mediaID
            let declaredIndex = (state["timelineIndex"] as? NSNumber)?.intValue ?? -1
            if declaredIndex >= 0, declaredIndex < items.count, items[declaredIndex].mediaId == mediaID { index = declaredIndex }
            else if let selected = QtIOSAudioOccurrence.index(items.map { $0.mediaId }, index,
                                                              items.map { $0.mediaId }, mediaID) { index = selected }
            remotePosition = max(0, (state["positionMs"] as? NSNumber)?.doubleValue ?? 0) / 1000
            remoteDuration = max(0, (state["durationMs"] as? NSNumber)?.doubleValue ?? 0) / 1000
            remoteCanSeek = state["canSeek"] as? Bool ?? false
            remotePhase = state["phase"] as? String ?? ""
            intending = playIntent
            if changed { requestArtwork(currentTrack()?.coverUrl ?? "") }
            if mediaID.isEmpty { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil }
            if remotePhase == "preparing" || remotePhase == "buffering" { emitWaiting() }
            else { lastWaiting = false }
            publishPlaying(remotePhase == "playing")
            emit("timeupdate", loadedID, remotePosition, remoteDuration)
            publishNowPlaying()
            updateCommands()
        }
    }

    /// Returning to local is orchestrated after successful remote Stop. Clearing
    /// ownership itself never starts a decoder or resurrects a suspended item.
    public func clearRemote() {
        mainValue {
            remoteOwned = false
            remotePhase = ""
            remoteCanSeek = false
            intending = false
            loadedID = ""
            pendingPosition = 0
            lastPlaying = false
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            updateCommands()
        }
    }

    public func setRemotePlaylist(_ json: String, _ selected: String) {
        mainValue {
            guard remoteOwned, let data = json.data(using: .utf8),
                  let tracks = try? JSONDecoder().decode([Track].self, from: data) else { return }
            items = tracks
            let candidate = Int(max(-1, min(Double(tracks.count - 1), finite(selected, -1))))
            index = candidate
            publishNowPlaying()
            updateCommands()
        }
    }

    public func reportRemoteEnded() {
        mainValue { if remoteOwned { emit("ended", loadedID) } }
    }

    public func requestNotificationPermission(_ callback: @escaping (Bool) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            if settings.authorizationStatus == .notDetermined {
                UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
                    DispatchQueue.main.async { callback(granted) }
                }
            } else {
                let granted = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
                DispatchQueue.main.async { callback(granted) }
            }
        }
    }

    public func postNotice(_ title: String, _ body: String) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            let request = UNNotificationRequest(identifier: "qt-audio-notice", content: content, trigger: nil)
            UNUserNotificationCenter.current().add(request)
        }
    }

    private func cacheIndexURL() -> URL { cacheDirectory.appendingPathComponent("index.json") }
    private func safeCacheFile(_ name: String) -> Bool {
        name.hasPrefix("qt-cache-") && !name.contains("/") && !name.contains("\\") && !name.contains("..")
    }

    private func restoreCache() {
        guard let data = try? Data(contentsOf: cacheIndexURL()),
              let entries = try? JSONDecoder().decode([String: CacheEntry].self, from: data) else { return }
        cache = entries.filter { safeCacheFile($0.value.file) }
        for (mediaID, entry) in cache where !files.fileExists(atPath: cacheDirectory.appendingPathComponent(entry.file).path) {
            cache.removeValue(forKey: mediaID)
        }
        trimCache()
    }

    private func saveCacheIndex() {
        if let data = try? JSONEncoder().encode(cache) { try? data.write(to: cacheIndexURL(), options: .atomic) }
    }

    // Cache identity includes the original placeholder URI (quality/source),
    // while explicit song eviction can remove every quality of that mediaId.
    private func cachedURL(_ sourceKey: String) -> URL? {
        guard var entry = cache[sourceKey], safeCacheFile(entry.file) else { return nil }
        let url = cacheDirectory.appendingPathComponent(entry.file)
        guard let attrs = try? files.attributesOfItem(atPath: url.path),
              let size = attrs[.size] as? NSNumber, size.int64Value == entry.bytes, entry.bytes > 0 else {
            cache.removeValue(forKey: sourceKey)
            saveCacheIndex()
            return nil
        }
        entry.touched = Date().timeIntervalSince1970
        cache[sourceKey] = entry
        pinnedCacheFile = entry.file
        saveCacheIndex()
        return url
    }

    public func setCacheLimit(_ megabytes: String) {
        mainValue {
            cacheLimit = Int64(max(0, min(8192, finite(megabytes, 1024))) * 1024 * 1024)
            if cacheLimit == 0 { _ = clearCache() } else { trimCache() }
        }
    }

    public func cacheSize() -> String { mainValue { String(cache.values.reduce(Int64(0)) { $0 + $1.bytes }) } }

    private func removeCached(_ mediaID: String) -> Bool {
        guard let entry = cache[mediaID] else { return true }
        if entry.file == pinnedCacheFile {
            deferredCacheFiles.insert(entry.file)
        } else {
            do {
                let url = cacheDirectory.appendingPathComponent(entry.file)
                if files.fileExists(atPath: url.path) { try files.removeItem(at: url) }
            } catch { return false }
        }
        cache.removeValue(forKey: mediaID)
        return true
    }

    public func evictSongCache(_ mediaID: String) -> Bool {
        mainValue {
            downloads.removeValue(forKey: mediaID)?.cancel()
            downloadTokens.removeValue(forKey: mediaID)
            resolved = resolved.filter { identityForURI($0.key) != mediaID }
            if let request = pending.removeValue(forKey: mediaID) { request.timer.cancel() }
            var result = true
            for key in cache.keys.filter({ $0 == mediaID || cache[$0]?.mediaId == mediaID }) {
                result = removeCached(key) && result
            }
            saveCacheIndex()
            return result
        }
    }

    public func clearCache() -> Bool {
        mainValue {
            cacheEpoch &+= 1
            for task in downloads.values { task.cancel() }
            downloads.removeAll()
            downloadTokens.removeAll()
            for (mediaID, request) in pending where request.preload {
                request.timer.cancel()
                pending.removeValue(forKey: mediaID)
            }
            resolved.removeAll()
            var result = true
            for mediaID in Array(cache.keys) { result = removeCached(mediaID) && result }
            saveCacheIndex()
            return result
        }
    }

    /// Forget source addresses/preloads without pausing a loaded item or
    /// deleting complete files. A foreground receipt becomes ineligible and is
    /// retried when it returns (or its timeout fires), avoiding overlapping
    /// mediaId-only resolution callbacks under different policies.
    public func invalidateSourcePolicy() {
        mainValue {
            sourcePolicy &+= 1
            cacheEpoch &+= 1
            resolved.removeAll()
            for (mediaID, request) in pending where request.preload {
                request.timer.cancel()
                pending.removeValue(forKey: mediaID)
            }
            for task in downloads.values { task.cancel() }
            downloads.removeAll()
            downloadTokens.removeAll()
            referers = referers.filter { $0.key == loadedID && player.currentItem != nil }
            if !remoteOwned, !loadedID.isEmpty, player.currentItem == nil,
               pending[loadedID] == nil, let item = currentTrack() {
                requestResolve(loadedID, item.uri, preload: false)
            }
        }
    }

    private func trimCache() {
        var total = cache.values.reduce(Int64(0)) { $0 + $1.bytes }
        for (mediaID, entry) in cache.sorted(by: { $0.value.touched < $1.value.touched }) {
            if total <= cacheLimit { break }
            if entry.file == pinnedCacheFile { continue }
            if removeCached(mediaID) { total -= entry.bytes }
        }
        saveCacheIndex()
    }

    public func preloadTrack(_ uri: String) {
        mainValue {
            guard cacheLimit > 0, !remoteOwned else { return }
            let mediaID = identityForURI(uri)
            guard !mediaID.isEmpty, cache[uri] == nil, downloads[mediaID] == nil, pending[mediaID] == nil else { return }
            if let item = items.first(where: { $0.uri == uri }), let url = resolvedURI(item) {
                beginPreload(mediaID, uri, url)
            } else if !uri.hasPrefix("qt-resolve://"), let url = mediaURL(uri) {
                beginPreload(mediaID, uri, url)
            } else { requestResolve(mediaID, uri, preload: true) }
        }
    }

    private func identityForURI(_ uri: String) -> String {
        if uri.hasPrefix("qt-resolve://") {
            return URLComponents(string: uri)?.queryItems?.first(where: { $0.name == "mid" })?.value ?? ""
        }
        return items.first(where: { $0.uri == uri })?.mediaId ?? uri
    }

    private func beginPreload(_ mediaID: String, _ sourceKey: String, _ url: URL) {
        guard !url.isFileURL, cacheLimit > 0, downloads.count < 2, downloads[mediaID] == nil else { return }
        let requestEpoch = cacheEpoch
        downloadRevision &+= 1
        let token = downloadRevision
        downloadTokens[mediaID] = token
        var request = URLRequest(url: url)
        request.timeoutInterval = 90
        if let referer = referers[mediaID], !referer.isEmpty { request.setValue(referer, forHTTPHeaderField: "Referer") }
        let task = network.downloadTask(with: request) { [weak self] temporary, response, _ in
            guard let self = self, let temporary = temporary,
                  let response = response as? HTTPURLResponse, response.statusCode == 200,
                  let attrs = try? self.files.attributesOfItem(atPath: temporary.path),
                  let bytes = attrs[.size] as? NSNumber, bytes.int64Value > 0,
                  bytes.int64Value <= 512 * 1024 * 1024,
                  response.expectedContentLength <= 0 || response.expectedContentLength == bytes.int64Value else {
                self?.onMain { self?.finishDownload(mediaID, token) }
                return
            }
            let mime = (response.mimeType ?? "").lowercased()
            guard !mime.contains("text/"), !mime.contains("json"), !mime.contains("html"),
                  !mime.contains("mpegurl") else {
                self.onMain { self.finishDownload(mediaID, token) }
                return
            }
            let extensionMap = [
                "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac",
                "audio/flac": "flac", "audio/x-flac": "flac", "audio/wav": "wav",
                "audio/x-wav": "wav", "audio/ogg": "ogg"
            ]
            let sourceExt = url.pathExtension.lowercased()
            let ext = extensionMap[mime] ?? (["mp3", "m4a", "aac", "flac", "wav", "aif", "aiff", "ogg"].contains(sourceExt) ? sourceExt : "audio")
            let name = "qt-cache-\(UUID().uuidString).\(ext)"
            let destination = self.cacheDirectory.appendingPathComponent(name)
            // URLSession removes the temporary URL after this callback returns.
            // Commit the copy before that return, then publish only its own epoch.
            do { try self.files.copyItem(at: temporary, to: destination) } catch {
                self.onMain { self.finishDownload(mediaID, token) }
                return
            }
            self.onMain {
                guard self.cacheEpoch == requestEpoch, self.downloadTokens[mediaID] == token,
                      self.cacheLimit >= bytes.int64Value else {
                    self.finishDownload(mediaID, token)
                    try? self.files.removeItem(at: destination)
                    return
                }
                self.finishDownload(mediaID, token)
                guard self.removeCached(sourceKey) else {
                    try? self.files.removeItem(at: destination)
                    return
                }
                self.cache[sourceKey] = CacheEntry(file: name, bytes: bytes.int64Value,
                                                   touched: Date().timeIntervalSince1970, mediaId: mediaID)
                self.trimCache()
            }
        }
        downloads[mediaID] = task
        task.resume()
    }

    private func finishDownload(_ mediaID: String, _ token: UInt64) {
        guard downloadTokens[mediaID] == token else { return }
        downloadTokens.removeValue(forKey: mediaID)
        downloads.removeValue(forKey: mediaID)
    }
}
