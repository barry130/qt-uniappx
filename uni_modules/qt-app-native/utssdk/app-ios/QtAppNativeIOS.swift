import Foundation
import UIKit
import UniformTypeIdentifiers
import UserNotifications
import WebKit
import AVFoundation
import Photos
import Darwin

private let qtIOSBookmarkKey = "qt-ios-folder-bookmarks-v1"
private let qtIOSCustomFolderKey = "qt-ios-custom-folder-v1"
private let qtIOSFileQueue = DispatchQueue(label: "music.qt.files", qos: .utility)

private func qtIOSJSON(_ value: Any) -> String {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value),
          let text = String(data: data, encoding: .utf8) else { return "{}" }
    return text
}

private func qtIOSOnMain<T>(_ work: () -> T) -> T {
    if Thread.isMainThread { return work() }
    return DispatchQueue.main.sync(execute: work)
}

private func qtIOSFileURL(_ raw: String) -> URL? {
    guard !raw.isEmpty else { return nil }
    if raw.hasPrefix("file://") {
        guard let url = URL(string: raw), url.isFileURL else { return nil }
        return url.standardizedFileURL
    }
    guard raw.hasPrefix("/") else { return nil }
    return URL(fileURLWithPath: raw).standardizedFileURL
}

/// Retains a directory's security scope for the complete I/O operation.
/// Old URLs in the download ledger still resolve after a file provider moves a folder.
private final class QtIOSFileAccess {
    let url: URL
    private let scope: URL?
    private var closed = false

    init?(_ raw: String) {
        guard let requested = qtIOSFileURL(raw) else { return nil }
        let home = URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().path
        let actual = requested.resolvingSymlinksInPath().path
        if actual.hasPrefix(home + "/") {
            url = requested
            scope = nil
            return
        }
        let saved = UserDefaults.standard.dictionary(forKey: qtIOSBookmarkKey) ?? [:]
        let keys = saved.keys.sorted { $0.count > $1.count }
        for key in keys {
            guard let oldRoot = qtIOSFileURL(key),
                  requested.path == oldRoot.path || requested.path.hasPrefix(oldRoot.path + "/"),
                  let data = saved[key] as? Data else { continue }
            var stale = false
            guard let root = try? URL(resolvingBookmarkData: data, options: [.withoutUI],
                                      relativeTo: nil, bookmarkDataIsStale: &stale),
                  root.startAccessingSecurityScopedResource() else { continue }
            let suffix = String(requested.path.dropFirst(oldRoot.path.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let resolved = suffix.isEmpty ? root : root.appendingPathComponent(suffix)
            let rootPath = root.resolvingSymlinksInPath().path
            let resolvedPath = resolved.resolvingSymlinksInPath().path
            guard resolvedPath == rootPath || resolvedPath.hasPrefix(rootPath + "/") else {
                root.stopAccessingSecurityScopedResource()
                continue
            }
            url = resolved
            scope = root
            if stale || root.standardizedFileURL.absoluteString != key {
                var updated = saved
                let fresh = (try? root.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)) ?? data
                updated[key] = fresh
                updated[root.standardizedFileURL.absoluteString] = fresh
                UserDefaults.standard.set(updated, forKey: qtIOSBookmarkKey)
            }
            return
        }
        return nil
    }

    func close() {
        if closed { return }
        closed = true
        scope?.stopAccessingSecurityScopedResource()
    }

    deinit { close() }
}

/// UTS uses this class directly; it is compiled in the same plugin framework.
public final class QtAppNativeIOS {
    fileprivate static var picker: QtIOSDocumentPicker?
    fileprivate static var auth: QtIOSAuthController?
    private static var notificationState: UNAuthorizationStatus?
    private static let stateLock = NSLock()
    private static var performanceObserver: [NSObjectProtocol] = []
    private static var performanceCallback: ((Bool, Bool, Bool) -> Void)?
    private static var memoryWarningSeen = false
    private static var coverFiles: [URL] = []
    private static var authGeneration = 0
    fileprivate static var authDismissInFlight = false
    private static var pendingAuthPresentation: (() -> Void)?

    public static func openExternalURL(_ raw: String) -> Bool {
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", url.host != nil else { return false }
        return qtIOSOnMain {
            guard UIApplication.shared.canOpenURL(url) else { return false }
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
            return true
        }
    }

    public static func openSettings() -> Bool {
        qtIOSOnMain {
            guard let url = URL(string: UIApplication.openSettingsURLString),
                  UIApplication.shared.canOpenURL(url) else { return false }
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
            return true
        }
    }

    fileprivate static func presentingController() -> UIViewController? {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive }.flatMap { $0.windows }
        guard var controller = (windows.first { $0.isKeyWindow } ?? windows.first)?.rootViewController else { return nil }
        while true {
            if let presented = controller.presentedViewController, !presented.isBeingDismissed {
                controller = presented
            } else if let navigation = controller as? UINavigationController, let visible = navigation.visibleViewController {
                controller = visible
            } else if let tabs = controller as? UITabBarController, let selected = tabs.selectedViewController {
                controller = selected
            } else { break }
        }
        return controller.isBeingDismissed ? nil : controller
    }

    public static func pickDocument(_ kind: String, _ callback: @escaping (String) -> Void) {
        DispatchQueue.main.async {
            guard picker == nil else {
                callback(qtIOSJSON(["ok": false, "message": "请先完成当前文件选择"]))
                return
            }
            guard let presenter = presentingController() else {
                callback(qtIOSJSON(["ok": false, "message": "无法打开文件选择器"]))
                return
            }
            let delegate = QtIOSDocumentPicker(kind, callback)
            picker = delegate
            let types: [UTType] = kind == "folder" ? [.folder] : (kind == "audio" ? [.audio] : [.javaScript, .plainText, .data])
            let controller = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: false)
            controller.allowsMultipleSelection = kind == "audio"
            controller.shouldShowFileExtensions = true
            controller.delegate = delegate
            delegate.controller = controller
            presenter.present(controller, animated: true) {
                controller.presentationController?.delegate = delegate
            }
        }
    }

    public static func setCustomDirectory(_ raw: String) {
        if raw.isEmpty { UserDefaults.standard.removeObject(forKey: qtIOSCustomFolderKey) }
        else { UserDefaults.standard.set(raw, forKey: qtIOSCustomFolderKey) }
    }

    public static func canWriteDownloads() -> Bool {
        let selected = UserDefaults.standard.string(forKey: qtIOSCustomFolderKey) ?? ""
        if selected.isEmpty { return true }
        guard let access = QtIOSFileAccess(selected) else { return false }
        defer { access.close() }
        let values = try? access.url.resourceValues(forKeys: [.isDirectoryKey])
        return values?.isDirectory == true
    }

    private static func safeComponent(_ raw: String) -> String? {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name != ".", name != "..", !name.contains("/"),
              !name.contains("\\"), !name.contains("\0") else { return nil }
        return name
    }

    private static func uniqueURL(_ folder: URL, _ fileName: String, _ attempt: Int) -> URL {
        if attempt == 0 { return folder.appendingPathComponent(fileName) }
        let original = URL(fileURLWithPath: fileName)
        let ext = original.pathExtension
        let stem = original.deletingPathExtension().lastPathComponent
        let suffix = ext.isEmpty ? "" : "." + ext
        return folder.appendingPathComponent(stem + " (" + String(attempt) + ")" + suffix)
    }

    /// Destination creation is exclusive. Failed writes only remove the file we created.
    fileprivate static func copyExclusive(_ source: URL, _ destination: URL) throws -> URL {
        var coordinationError: NSError?
        var ioError: Error?
        var completed: URL?
        let coordinator = NSFileCoordinator(filePresenter: nil)
        coordinator.coordinate(readingItemAt: source, options: .withoutChanges,
                               writingItemAt: destination, options: [], error: &coordinationError) { inputURL, outputURL in
            let fd = Darwin.open(outputURL.path, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
            guard fd >= 0 else {
                ioError = NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
                return
            }
            let output = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            var outputClosed = false
            do {
                let input = try FileHandle(forReadingFrom: inputURL)
                var inputClosed = false
                defer { if !inputClosed { try? input.close() } }
                let attrs = try FileManager.default.attributesOfItem(atPath: inputURL.path)
                guard attrs[.type] as? FileAttributeType == .typeRegular,
                      let length = (attrs[.size] as? NSNumber)?.uint64Value else {
                    throw CocoaError(.fileReadUnknown)
                }
                var remaining = length
                while remaining > 0 {
                    guard let data = try input.read(upToCount: Int(min(remaining, 256 * 1024))), !data.isEmpty else {
                        throw CocoaError(.fileReadCorruptFile)
                    }
                    try output.write(contentsOf: data)
                    remaining -= UInt64(data.count)
                }
                try input.close()
                inputClosed = true
                try output.synchronize()
                try output.close()
                outputClosed = true
                completed = outputURL
            } catch {
                if !outputClosed { try? output.close() }
                try? FileManager.default.removeItem(at: outputURL)
                ioError = error
            }
        }
        if let error = ioError { throw error }
        if let error = coordinationError {
            if let result = completed { try? FileManager.default.removeItem(at: result) }
            throw error
        }
        guard let result = completed else { throw CocoaError(.fileWriteUnknown) }
        return result
    }

    fileprivate static func copyUnique(_ source: URL, _ folder: URL, _ fileName: String) throws -> URL {
        for attempt in 0..<1000 {
            do { return try copyExclusive(source, uniqueURL(folder, fileName, attempt)) }
            catch let error as NSError {
                if error.domain == NSPOSIXErrorDomain && error.code == Int(EEXIST) { continue }
                throw error
            }
        }
        throw CocoaError(.fileWriteFileExists)
    }

    public static func saveFile(_ raw: String, _ kind: String, _ fileName: String,
                                _ subDirectory: String, _ customDirectory: String,
                                _ callback: @escaping (String) -> Void) {
        qtIOSFileQueue.async {
            guard let source = QtIOSFileAccess(raw), let name = safeComponent(fileName) else {
                DispatchQueue.main.async { callback("") }
                return
            }
            defer { source.close() }
            let selected = customDirectory.isEmpty ? (UserDefaults.standard.string(forKey: qtIOSCustomFolderKey) ?? "") : customDirectory
            let target = selected.isEmpty ? nil : QtIOSFileAccess(selected)
            defer { target?.close() }
            if !selected.isEmpty && target == nil {
                DispatchQueue.main.async { callback("") }
                return
            }
            do {
                var folder: URL
                if let chosen = target { folder = chosen.url }
                else {
                    folder = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                        .appendingPathComponent(kind == "music" ? "Music" : "Downloads", isDirectory: true)
                    let parts = (subDirectory.isEmpty ? "轻听" : subDirectory).split(separator: "/")
                    for part in parts {
                        guard let safe = safeComponent(String(part)) else { throw CocoaError(.fileWriteInvalidFileName) }
                        folder.appendPathComponent(safe, isDirectory: true)
                    }
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                }
                let saved = try copyUnique(source.url, folder, name)
                DispatchQueue.main.async { callback(saved.absoluteString) }
            } catch {
                NSLog("[qt-app-native] saveFile failed: %@", error.localizedDescription)
                DispatchQueue.main.async { callback("") }
            }
        }
    }

    public static func savePhoto(_ raw: String, _ callback: @escaping (String) -> Void) {
        guard let source = QtIOSFileAccess(raw) else { callback(""); return }
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                source.close()
                DispatchQueue.main.async { callback("") }
                return
            }
            var assetIdentifier = ""
            PHPhotoLibrary.shared().performChanges({
                assetIdentifier = PHAssetChangeRequest.creationRequestForAssetFromImage(atFileURL: source.url)?.placeholderForCreatedAsset?.localIdentifier ?? ""
            }) { ok, error in
                source.close()
                if let error = error { NSLog("[qt-app-native] savePhoto failed: %@", error.localizedDescription) }
                DispatchQueue.main.async { callback(ok && !assetIdentifier.isEmpty ? "ph://" + assetIdentifier : "") }
            }
        }
    }

    public static func statFile(_ raw: String) -> NSNumber {
        guard let access = QtIOSFileAccess(raw) else { return -1 }
        defer { access.close() }
        guard FileManager.default.isReadableFile(atPath: access.url.path),
              let attrs = try? FileManager.default.attributesOfItem(atPath: access.url.path),
              attrs[.type] as? FileAttributeType == .typeRegular,
              let size = attrs[.size] as? NSNumber else { return -1 }
        return size
    }

    public static func deleteFiles(_ pathsJSON: String) -> NSNumber {
        guard let data = pathsJSON.data(using: .utf8),
              let paths = try? JSONSerialization.jsonObject(with: data) as? [String] else { return 0 }
        var deleted = 0
        var seen = Set<String>()
        for raw in paths {
            guard let access = QtIOSFileAccess(raw) else { continue }
            defer { access.close() }
            guard !seen.contains(access.url.path) else { continue }
            seen.insert(access.url.path)
            guard let attrs = try? FileManager.default.attributesOfItem(atPath: access.url.path),
                  attrs[.type] as? FileAttributeType == .typeRegular else { continue }
            do {
                var coordinationError: NSError?
                var deletionError: Error?
                NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: access.url, options: .forDeleting,
                                                                 error: &coordinationError) { url in
                    do { try FileManager.default.removeItem(at: url) }
                    catch { deletionError = error }
                }
                if let error = coordinationError { throw error }
                if let error = deletionError { throw error }
                deleted += 1
            } catch { NSLog("[qt-app-native] deleteFile failed: %@", error.localizedDescription) }
        }
        return NSNumber(value: deleted)
    }

    public static func readPrefix(_ raw: String, _ limit: NSNumber) -> String {
        guard limit.intValue > 0, limit.intValue <= 16 * 1024 * 1024,
              let access = QtIOSFileAccess(raw) else { return "" }
        defer { access.close() }
        var coordinationError: NSError?
        var result = ""
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: access.url, options: .withoutChanges,
                                                         error: &coordinationError) { url in
            do {
                let input = try FileHandle(forReadingFrom: url)
                var closed = false
                defer { if !closed { try? input.close() } }
                let data = try input.read(upToCount: limit.intValue)
                try input.close()
                closed = true
                result = data?.base64EncodedString() ?? ""
            } catch { result = "" }
        }
        return coordinationError == nil ? result : ""
    }

    private static func writeTagPlan(_ source: URL, _ destination: URL, _ parts: [[String: Any]]) throws -> URL {
        var coordinationError: NSError?
        var ioError: Error?
        var completed: URL?
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: source, options: .withoutChanges,
                                                         writingItemAt: destination, options: [], error: &coordinationError) { inputURL, outputURL in
            let fd = Darwin.open(outputURL.path, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
            guard fd >= 0 else { ioError = NSError(domain: NSPOSIXErrorDomain, code: Int(errno)); return }
            let writer = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            var writerClosed = false
            do {
                let input = try FileHandle(forReadingFrom: inputURL)
                var inputClosed = false
                defer { if !inputClosed { try? input.close() } }
                let length = try input.seekToEnd()
                guard !parts.isEmpty, let tail = parts.last,
                      let tailOffset = tail["offset"] as? NSNumber, let tailCount = tail["length"] as? NSNumber,
                      tailOffset.doubleValue >= 0, tailCount.doubleValue >= 0,
                      tailOffset.uint64Value <= length, tailCount.uint64Value == length - tailOffset.uint64Value else {
                    throw CocoaError(.fileReadCorruptFile)
                }
                for part in parts {
                    if let encoded = part["data"] as? String {
                        guard let data = Data(base64Encoded: encoded) else { throw CocoaError(.fileReadCorruptFile) }
                        try writer.write(contentsOf: data)
                    } else {
                        guard let start = part["offset"] as? NSNumber, let count = part["length"] as? NSNumber,
                              start.doubleValue >= 0, count.doubleValue >= 0,
                              start.uint64Value <= length, count.uint64Value <= length - start.uint64Value else {
                            throw CocoaError(.fileReadCorruptFile)
                        }
                        try input.seek(toOffset: start.uint64Value)
                        var remaining = count.uint64Value
                        while remaining > 0 {
                            guard let data = try input.read(upToCount: Int(min(remaining, 256 * 1024))), !data.isEmpty else {
                                throw CocoaError(.fileReadCorruptFile)
                            }
                            try writer.write(contentsOf: data)
                            remaining -= UInt64(data.count)
                        }
                    }
                }
                guard try input.seekToEnd() == length else { throw CocoaError(.fileReadCorruptFile) }
                try input.close()
                inputClosed = true
                try writer.synchronize()
                try writer.close()
                writerClosed = true
                completed = outputURL
            } catch {
                if !writerClosed { try? writer.close() }
                try? FileManager.default.removeItem(at: outputURL)
                ioError = error
            }
        }
        if let error = ioError { throw error }
        if let error = coordinationError {
            if let result = completed { try? FileManager.default.removeItem(at: result) }
            throw error
        }
        guard let result = completed else { throw CocoaError(.fileWriteUnknown) }
        return result
    }

    public static func writeTagCopy(_ raw: String, _ ext: String, _ partsJSON: String,
                                    _ callback: @escaping (String) -> Void) {
        qtIOSFileQueue.async {
            guard let source = QtIOSFileAccess(raw), ext == "mp3" || ext == "flac",
                  let json = partsJSON.data(using: .utf8),
                  let parts = try? JSONSerialization.jsonObject(with: json) as? [[String: Any]] else {
                DispatchQueue.main.async { callback(raw) }
                return
            }
            defer { source.close() }
            do {
                let base = source.url.lastPathComponent + ".embed." + ext
                var completed: URL?
                for attempt in 0..<1000 {
                    let candidate = uniqueURL(source.url.deletingLastPathComponent(), base, attempt)
                    do {
                        completed = try writeTagPlan(source.url, candidate, parts)
                        break
                    } catch let error as NSError {
                        if error.domain == NSPOSIXErrorDomain && error.code == Int(EEXIST) { continue }
                        throw error
                    }
                }
                guard let destination = completed else { throw CocoaError(.fileWriteFileExists) }
                DispatchQueue.main.async { callback(destination.path) }
            } catch {
                NSLog("[qt-app-native] writeTagCopy failed: %@", error.localizedDescription)
                DispatchQueue.main.async { callback(source.url.path) }
            }
        }
    }

    public static func cacheCover(_ encoded: String, _ mime: String) -> String {
        guard let data = Data(base64Encoded: encoded), !data.isEmpty,
              let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return "" }
        stateLock.lock()
        defer { stateLock.unlock() }
        let url = folder.appendingPathComponent("qt-embed-cover-" + UUID().uuidString + (mime.contains("png") ? ".png" : ".jpg"))
        do {
            try data.write(to: url, options: .atomic)
            coverFiles.append(url)
            while coverFiles.count > 24 { try? FileManager.default.removeItem(at: coverFiles.removeFirst()) }
            return url.path
        } catch { return "" }
    }

    public static func scanAudio(_ callback: @escaping (String) -> Void) {
        qtIOSFileQueue.async {
            var roots = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)
            let selected = UserDefaults.standard.string(forKey: qtIOSCustomFolderKey) ?? ""
            let scoped = selected.isEmpty ? nil : QtIOSFileAccess(selected)
            if let access = scoped { roots.append(access.url) }
            defer { scoped?.close() }
            let extensions = Set(["mp3", "m4a", "aac", "wav", "wave", "aif", "aiff", "flac", "caf", "mp4"])
            var items: [[String: Any]] = []
            var seen = Set<String>()
            let keys: Set<URLResourceKey> = [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey, .isSymbolicLinkKey]
            for root in roots {
                guard let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: Array(keys),
                                                                 options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { continue }
                for case let file as URL in files {
                    if items.count >= 10000 { break }
                    guard extensions.contains(file.pathExtension.lowercased()),
                          !seen.contains(file.path),
                          let values = try? file.resourceValues(forKeys: keys), values.isRegularFile == true,
                          values.isSymbolicLink != true else { continue }
                    seen.insert(file.path)
                    let asset = AVURLAsset(url: file, options: [AVURLAssetPreferPreciseDurationAndTimingKey: false])
                    let duration = CMTimeGetSeconds(asset.duration)
                    var title = file.deletingPathExtension().lastPathComponent
                    var singer = ""
                    var album = ""
                    for tag in asset.commonMetadata {
                        guard let value = tag.stringValue, !value.isEmpty else { continue }
                        if tag.commonKey == .commonKeyTitle { title = value }
                        if tag.commonKey == .commonKeyArtist { singer = value }
                        if tag.commonKey == .commonKeyAlbumName { album = value }
                    }
                    items.append([
                        "id": file.absoluteString, "title": title, "singer": singer, "album": album,
                        "duration": duration.isFinite && duration >= 0 ? duration : 0,
                        "uri": file.absoluteString, "path": file.path,
                        "size": values.fileSize ?? 0,
                        "mtime": values.contentModificationDate?.timeIntervalSince1970 ?? 0, "isMusic": 1
                    ])
                }
            }
            items.sort { ($0["mtime"] as? Double ?? 0) > ($1["mtime"] as? Double ?? 0) }
            let json = qtIOSJSON(items)
            DispatchQueue.main.async { callback(json) }
        }
    }

    public static func queryPermissions(_ idsJSON: String) -> String {
        guard let data = idsJSON.data(using: .utf8),
              let ids = try? JSONSerialization.jsonObject(with: data) as? [String] else { return "[]" }
        stateLock.lock()
        let notifications = notificationState
        stateLock.unlock()
        var result: [[String: Any]] = []
        for id in ids {
            var granted = false
            var unknown = false
            var applicable = true
            switch id {
            case "ios.notifications":
                if let status = notifications { granted = status == .authorized || status == .provisional || status == .ephemeral }
                else { unknown = true }
            case "ios.photosAdd":
                let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
                granted = status == .authorized || status == .limited
            case "ios.files": granted = true
            case "ios.backgroundAudio":
                granted = (Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String])?.contains("audio") == true
            case "ios.localNetwork":
                // iOS has no public API that reads this switch. Discovery triggers its system prompt.
                unknown = true
            default:
                applicable = false
                unknown = true
            }
            result.append(["id": id, "applicable": applicable, "granted": granted, "unknown": unknown])
        }
        return qtIOSJSON(result)
    }

    public static func refreshPermissions(_ idsJSON: String, _ callback: @escaping (String) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            stateLock.lock()
            notificationState = settings.authorizationStatus
            stateLock.unlock()
            let result = queryPermissions(idsJSON)
            DispatchQueue.main.async { callback(result) }
        }
    }

    public static func openAuthWebView(_ raw: String, _ userAgent: String, _ onClose: @escaping (String) -> Void) {
        let generation = qtIOSOnMain { authGeneration += 1; return authGeneration }
        DispatchQueue.main.async {
            guard generation == authGeneration else { return }
            let present: () -> Void = {
                guard generation == authGeneration else { return }
                guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(),
                      (scheme == "http" || scheme == "https"), url.host != nil else {
                    onClose("登录地址无效")
                    return
                }
                guard let presenter = presentingController() else {
                    onClose("无法打开登录页面")
                    return
                }
                let controller = QtIOSAuthController(url, userAgent, onClose)
                auth = controller
                let navigation = UINavigationController(rootViewController: controller)
                navigation.modalPresentationStyle = .pageSheet
                presenter.present(navigation, animated: true)
            }
            pendingAuthPresentation = present
            if authDismissInFlight { return }
            if let previous = auth { previous.finish("", notify: false) }
            else { presentPendingAuth() }
        }
    }

    fileprivate static func presentPendingAuth() {
        guard !authDismissInFlight else { return }
        let next = pendingAuthPresentation
        pendingAuthPresentation = nil
        next?()
    }

    public static func closeAuthWebView() {
        qtIOSOnMain {
            authGeneration += 1
            pendingAuthPresentation = nil
            guard let controller = auth else { return }
            controller.finish("", notify: false)
        }
    }

    public static func webCookies(_ urlsJSON: String, _ callback: @escaping (String) -> Void) {
        guard let data = urlsJSON.data(using: .utf8),
              let urls = try? JSONSerialization.jsonObject(with: data) as? [String] else { callback("[]"); return }
        DispatchQueue.main.async {
            WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
                var result: [String] = []
                for raw in urls {
                    guard let url = URL(string: raw), let host = url.host?.lowercased(),
                          url.scheme == "http" || url.scheme == "https" else { continue }
                    let path = url.path.isEmpty ? "/" : url.path
                    let matching = cookies.filter { cookie in
                        let originalDomain = cookie.domain.lowercased()
                        let domain = originalDomain.hasPrefix(".") ? String(originalDomain.dropFirst()) : originalDomain
                        let matchesDomain = host == domain || (originalDomain.hasPrefix(".") && host.hasSuffix("." + domain))
                        let cookiePath = cookie.path.isEmpty ? "/" : cookie.path
                        let matchesPath = path == cookiePath || (path.hasPrefix(cookiePath) && (cookiePath.hasSuffix("/") || path.dropFirst(cookiePath.count).hasPrefix("/")))
                        let notExpired = cookie.expiresDate == nil || cookie.expiresDate! > Date()
                        return matchesDomain && matchesPath && notExpired && (!cookie.isSecure || url.scheme == "https")
                    }.sorted { $0.path.count > $1.path.count }
                    // HttpOnly cookies intentionally remain available to the source-auth host.
                    let header = matching.map { $0.name + "=" + $0.value }.joined(separator: "; ")
                    if !header.isEmpty { result.append(header) }
                }
                callback(qtIOSJSON(result))
            }
        }
    }

    public static func readPerformance(_ callback: @escaping (Bool, Bool, Bool) -> Void) {
        DispatchQueue.main.async {
            callback(memoryWarningSeen || ProcessInfo.processInfo.physicalMemory <= 2 * 1024 * 1024 * 1024,
                     ProcessInfo.processInfo.isLowPowerModeEnabled, UIAccessibility.isReduceMotionEnabled)
        }
    }

    public static func startPerformance(_ callback: @escaping (Bool, Bool, Bool) -> Void) {
        DispatchQueue.main.async {
            stopPerformance()
            performanceCallback = callback
            let names: [Notification.Name] = [
                UIApplication.didReceiveMemoryWarningNotification,
                Notification.Name.NSProcessInfoPowerStateDidChange,
                UIAccessibility.reduceMotionStatusDidChangeNotification
            ]
            for name in names {
                performanceObserver.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { notification in
                    if notification.name == UIApplication.didReceiveMemoryWarningNotification { memoryWarningSeen = true }
                    performanceCallback?(memoryWarningSeen || ProcessInfo.processInfo.physicalMemory <= 2 * 1024 * 1024 * 1024,
                                         ProcessInfo.processInfo.isLowPowerModeEnabled, UIAccessibility.isReduceMotionEnabled)
                })
            }
        }
    }

    public static func stopPerformance() {
        qtIOSOnMain {
            for observer in performanceObserver { NotificationCenter.default.removeObserver(observer) }
            performanceObserver.removeAll()
            performanceCallback = nil
        }
    }
}

fileprivate final class QtIOSDocumentPicker: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    let kind: String
    private var callback: ((String) -> Void)?
    weak var controller: UIDocumentPickerViewController?
    private var selectionStarted = false

    init(_ kind: String, _ callback: @escaping (String) -> Void) {
        self.kind = kind
        self.callback = callback
    }

    private func finish(_ result: [String: Any]) {
        DispatchQueue.main.async {
            guard let callback = self.callback else { return }
            self.callback = nil
            if QtAppNativeIOS.picker === self { QtAppNativeIOS.picker = nil }
            callback(qtIOSJSON(result))
        }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finish(["ok": false, "message": "已取消选择"])
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        if !selectionStarted { finish(["ok": false, "message": "已取消选择"]) }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        selectionStarted = true
        guard let first = urls.first else { finish(["ok": false, "message": "未选择文件"]); return }
        qtIOSFileQueue.async {
            if self.kind == "folder" {
                let accessing = first.startAccessingSecurityScopedResource()
                defer { if accessing { first.stopAccessingSecurityScopedResource() } }
                do {
                    let values = try first.resourceValues(forKeys: [.isDirectoryKey])
                    guard values.isDirectory == true else { throw CocoaError(.fileWriteInvalidFileName) }
                    let probe = first.appendingPathComponent(".qt-write-check-" + UUID().uuidString)
                    let fd = Darwin.open(probe.path, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
                    guard fd >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
                    Darwin.close(fd)
                    try FileManager.default.removeItem(at: probe)
                    let bookmark = try first.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
                    let raw = first.standardizedFileURL.absoluteString
                    var saved = UserDefaults.standard.dictionary(forKey: qtIOSBookmarkKey) ?? [:]
                    saved[raw] = bookmark
                    UserDefaults.standard.set(saved, forKey: qtIOSBookmarkKey)
                    self.finish(["ok": true, "path": raw, "name": first.lastPathComponent, "message": ""])
                } catch { self.finish(["ok": false, "message": "无法写入所选目录，请重新选择可写目录"]) }
                return
            }
            if self.kind == "audio" {
                var imported = 0
                var failed = 0
                let types = Set(["mp3", "m4a", "aac", "wav", "wave", "aif", "aiff", "flac", "caf", "mp4"])
                do {
                    let folder = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                        .appendingPathComponent("Imports", isDirectory: true)
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    for url in urls {
                        let accessing = url.startAccessingSecurityScopedResource()
                        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
                        guard types.contains(url.pathExtension.lowercased()) else { failed += 1; continue }
                        do {
                            _ = try QtAppNativeIOS.copyUnique(url, folder, url.lastPathComponent)
                            imported += 1
                        } catch { failed += 1 }
                    }
                } catch { failed = urls.count }
                self.finish(["ok": imported > 0, "count": imported,
                             "message": failed > 0 ? String(failed) + " 个文件未能导入" : ""])
                return
            }
            guard first.pathExtension.lowercased() == "js" else {
                self.finish(["ok": false, "message": "请选择 .js 音源文件"])
                return
            }
            let accessing = first.startAccessingSecurityScopedResource()
            defer { if accessing { first.stopAccessingSecurityScopedResource() } }
            var coordinationError: NSError?
            var text: String?
            NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: first, options: .withoutChanges, error: &coordinationError) { url in
                guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
                      let size = attrs[.size] as? NSNumber, size.intValue <= 16 * 1024 * 1024,
                      let data = try? Data(contentsOf: url) else { return }
                text = String(data: data, encoding: .utf8)
            }
            guard coordinationError == nil, let content = text else {
                self.finish(["ok": false, "message": "无法读取文件（仅支持 16 MB 以内的 UTF-8 文本）"])
                return
            }
            self.finish(["ok": true, "name": first.lastPathComponent, "content": content, "message": ""])
        }
    }
}

fileprivate final class QtIOSAuthController: UIViewController, WKNavigationDelegate, WKUIDelegate, UIAdaptivePresentationControllerDelegate {
    private let initialURL: URL
    private let userAgent: String
    private var onClose: ((String) -> Void)?
    private var webView: WKWebView?
    private var finished = false

    init(_ url: URL, _ userAgent: String, _ callback: @escaping (String) -> Void) {
        self.initialURL = url
        self.userAgent = userAgent
        self.onClose = callback
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "网页登录"
        view.backgroundColor = .systemBackground
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "返回", style: .plain, target: self, action: #selector(goBack))
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "关闭", style: .done, target: self, action: #selector(userClose))
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = WKWebsiteDataStore.default()
        let browser = WKWebView(frame: .zero, configuration: configuration)
        browser.navigationDelegate = self
        browser.uiDelegate = self
        browser.allowsBackForwardNavigationGestures = true
        if !userAgent.isEmpty { browser.customUserAgent = userAgent }
        browser.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(browser)
        NSLayoutConstraint.activate([
            browser.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            browser.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            browser.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            browser.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        webView = browser
        browser.load(URLRequest(url: initialURL))
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        navigationController?.presentationController?.delegate = self
    }

    @objc private func userClose() { finish("", notify: true) }
    @objc private func goBack() {
        if webView?.canGoBack == true { webView?.goBack() }
        else { userClose() }
    }

    fileprivate func finish(_ message: String, notify: Bool) {
        guard !finished else { return }
        finished = true
        let callback = onClose
        onClose = nil
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView?.uiDelegate = nil
        if QtAppNativeIOS.auth === self { QtAppNativeIOS.auth = nil }
        if let navigation = navigationController, navigation.presentingViewController != nil {
            QtAppNativeIOS.authDismissInFlight = true
            navigation.dismiss(animated: true) {
                QtAppNativeIOS.authDismissInFlight = false
                QtAppNativeIOS.presentPendingAuth()
            }
        } else {
            QtAppNativeIOS.presentPendingAuth()
        }
        if notify { callback?(message) }
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        finish("", notify: true)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard !finished, let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else {
            decisionHandler(.cancel)
            return
        }
        if scheme == "http" || scheme == "https" || scheme == "about" {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        if scheme == "javascript" || scheme == "data" || scheme == "file" || scheme == "blob" { return }
        UIApplication.shared.open(url, options: [:]) { [weak self] opened in
            if !opened { self?.finish("无法打开授权应用，请确认已安装相应应用", notify: true) }
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
        return nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        finish("登录页面加载失败，请检查网络后重试", notify: true)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        finish("登录页面加载失败，请检查网络后重试", notify: true)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        finish("登录页面已被系统关闭，请重试", notify: true)
    }
}
