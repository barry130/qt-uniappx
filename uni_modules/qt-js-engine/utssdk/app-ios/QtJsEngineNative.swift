import Foundation
import WebKit
import UIKit
import CryptoKit
import CoreFoundation
import Darwin

/// System dependencies only. No script bridge exposes arbitrary native selectors or files.
/// WKWebView supplies JavaScriptCore's ES-module loader; JSContext has no public ESM API.
public final class QtJsEngineNative: NSObject, WKNavigationDelegate, WKURLSchemeHandler {
    private static let shared = QtJsEngineNative()
    private static let maxBytes = 8 * 1024 * 1024
    private static let files = DispatchQueue(label: "qt.source.files", qos: .utility)
    private static let crypto = DispatchQueue(label: "qt.source.signature", qos: .userInitiated)
    private static let scheme = "qtsource"
    private static let base = "qtsource://engine/index.html"
    private static let csp = "default-src 'none'; script-src qtsource: 'unsafe-eval'; " +
        "connect-src 'none'; img-src 'none'; media-src 'none'; frame-src 'none'; " +
        "object-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'"
    private static let html = "<!doctype html><html><head><meta charset=\"utf-8\">" +
        "<meta http-equiv=\"Content-Security-Policy\" content=\"" + csp + "\">" +
        "</head><body></body></html>"
    private var webView: WKWebView?
    private var healthy = false
    private var ready = false
    private var epoch = 0
    private var moduleSeq = 0
    private var modules: [String: Data] = [:]
    private var prepareCallbacks: [(String, String) -> Void] = []
    private var evalCallbacks: [UUID: (String, String) -> Void] = [:]
    private var requests: [UUID: QtSourceHttpTask] = [:]

    private override init() { super.init() }

    private static func onMain(_ action: @escaping () -> Void) {
        if Thread.isMainThread { action() }
        else { DispatchQueue.main.async(execute: action) }
    }

    private static func reply(_ callback: @escaping (String, String) -> Void, _ value: String, _ error: String) {
        DispatchQueue.main.async { callback(value, error) }
    }

    public static func prepare(_ callback: @escaping (String, String) -> Void) {
        onMain { shared.prepareOnMain(callback) }
    }

    private func prepareOnMain(_ callback: @escaping (String, String) -> Void) {
        if ready && healthy {
            Self.reply(callback, UIDevice.current.systemVersion, "")
            return
        }
        prepareCallbacks.append(callback)
        if webView != nil { return }
        epoch += 1
        let generation = epoch
        // CSP is the first barrier; these rules also block elements/modules that bypass the host API.
        let rules = """
        [
          {"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}},
          {"trigger":{"url-filter":"^wss?://"},"action":{"type":"block"}},
          {"trigger":{"url-filter":"^file://"},"action":{"type":"block"}}
        ]
        """
        WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "qt-source-native-egress-v1",
            encodedContentRuleList: rules
        ) { [weak self] list, error in
            Self.onMain {
                guard let self = self, self.epoch == generation else { return }
                guard let list = list, error == nil else {
                    self.failPreparation("无法创建音源包网络隔离规则：" + (error?.localizedDescription ?? "unknown error"))
                    return
                }
                let config = WKWebViewConfiguration()
                config.websiteDataStore = .nonPersistent()
                config.processPool = WKProcessPool()
                config.userContentController.add(list)
                config.setURLSchemeHandler(self, forURLScheme: Self.scheme)
                config.preferences.javaScriptCanOpenWindowsAutomatically = false
                config.defaultWebpagePreferences.allowsContentJavaScript = true
                config.mediaTypesRequiringUserActionForPlayback = .all
                config.allowsAirPlayForMediaPlayback = false
                let view = WKWebView(frame: CGRect(x: -2, y: -2, width: 1, height: 1), configuration: config)
                view.navigationDelegate = self
                view.isUserInteractionEnabled = false
                view.isAccessibilityElement = false
                view.accessibilityElementsHidden = true
                view.alpha = 0.01
                view.isOpaque = false
                self.webView = view
                self.healthy = true
                // A window attachment keeps ordinary foreground module loading independent of pages.
                // Native audio background playback remains owned by qt-audio-player.
                self.attachToWindow(view)
                guard let url = URL(string: Self.base) else {
                    self.failPreparation("音源引擎页面地址无效")
                    return
                }
                view.load(URLRequest(url: url))
            }
        }
    }

    public static func stop(_ callback: @escaping (String, String) -> Void) {
        onMain {
            shared.dispose("音源引擎已停止")
            reply(callback, "", "")
        }
    }

    private func failPreparation(_ error: String) {
        let callbacks = prepareCallbacks
        prepareCallbacks.removeAll()
        dispose(error)
        callbacks.forEach { Self.reply($0, "", error) }
    }

    private func dispose(_ reason: String) {
        epoch += 1
        healthy = false
        ready = false
        let preparations = prepareCallbacks
        prepareCallbacks.removeAll()
        let evaluations = Array(evalCallbacks.values)
        evalCallbacks.removeAll()
        let activeRequests = Array(requests.values)
        requests.removeAll()
        modules.removeAll()
        moduleSeq = 0
        let view = webView
        webView = nil
        view?.navigationDelegate = nil
        view?.stopLoading()
        view?.removeFromSuperview()
        preparations.forEach { Self.reply($0, "", reason) }
        evaluations.forEach { Self.reply($0, "", reason) }
        activeRequests.forEach { $0.cancel(reason) }
    }

    public static func isHealthy() -> Bool {
        return shared.healthy
    }

    private func attachToWindow(_ view: WKWebView) {
        guard view.superview == nil else { return }
        let window = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }
        window?.addSubview(view)
    }

    public static func evaluate(_ code: String, _ callback: @escaping (String, String) -> Void) {
        onMain {
            guard let view = shared.webView, shared.healthy, shared.ready else {
                reply(callback, "", "JavaScriptCore 页面未就绪")
                return
            }
            shared.attachToWindow(view)
            let ticket = UUID()
            let generation = shared.epoch
            shared.evalCallbacks[ticket] = callback
            view.evaluateJavaScript(code) { value, error in
                onMain {
                    guard shared.epoch == generation,
                          let done = shared.evalCallbacks.removeValue(forKey: ticket) else { return }
                    if let error = error {
                        reply(done, "", error.localizedDescription)
                    } else if let text = value as? String {
                        reply(done, text, "")
                    } else if value == nil || value is NSNull {
                        reply(done, "", "")
                    } else {
                        reply(done, String(describing: value!), "")
                    }
                }
            }
        }
    }

    /// A fresh URL per load bypasses the ES-module cache without rewriting package source.
    public static func provideModule(_ slot: String, _ source: String, _ callback: @escaping (String, String) -> Void) {
        onMain {
            guard shared.ready && shared.healthy else {
                reply(callback, "", "音源引擎未就绪")
                return
            }
            guard slot == "meta" || slot == "play" else {
                reply(callback, "", "未知音源包槽位")
                return
            }
            let bytes = Data(source.utf8)
            guard !bytes.isEmpty && bytes.count <= maxBytes else {
                reply(callback, "", "音源包为空或超过 8MB 上限")
                return
            }
            shared.moduleSeq += 1
            let path = "/\(slot)-\(shared.epoch)-\(shared.moduleSeq).js"
            shared.modules[path] = bytes
            reply(callback, "\(scheme)://engine\(path)", "")
        }
    }

    public static func releaseModule(_ address: String) {
        onMain {
            guard let url = URL(string: address), url.scheme == scheme, url.host == "engine" else { return }
            shared.modules.removeValue(forKey: url.path)
        }
    }

    public func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let request = urlSchemeTask.request
        guard webView === self.webView,
              let url = request.url, url.scheme == Self.scheme, url.host == "engine",
              url.user == nil, url.password == nil, url.query == nil,
              request.httpMethod == "GET" || request.httpMethod == "HEAD" else {
            urlSchemeTask.didFailWithError(NSError(domain: "qt.source", code: 403, userInfo: [
                NSLocalizedDescriptionKey: "音源包只能读取已提供的本地模块"
            ]))
            return
        }
        let isHTML = url.path == "/index.html"
        guard let body = isHTML ? Self.html.data(using: .utf8) : modules[url.path] else {
            urlSchemeTask.didFailWithError(NSError(domain: "qt.source", code: 404, userInfo: [
                NSLocalizedDescriptionKey: "本地音源模块不存在"
            ]))
            return
        }
        let headers = [
            "Content-Type": isHTML ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
            "Content-Length": String(body.count),
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
            "Content-Security-Policy": Self.csp
        ]
        guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
            urlSchemeTask.didFailWithError(NSError(domain: "qt.source", code: 500))
            return
        }
        urlSchemeTask.didReceive(response)
        if request.httpMethod != "HEAD" { urlSchemeTask.didReceive(body) }
        urlSchemeTask.didFinish()
    }

    public func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // Responses above are completed synchronously; no retained scheme task can receive a late reply.
    }

    public func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard webView === self.webView, let url = navigationAction.request.url,
              url.absoluteString == Self.base, navigationAction.navigationType == .other,
              navigationAction.targetFrame?.isMainFrame == true else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView else { return }
        ready = true
        let callbacks = prepareCallbacks
        prepareCallbacks.removeAll()
        callbacks.forEach { Self.reply($0, UIDevice.current.systemVersion, "") }
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard webView === self.webView else { return }
        failPreparation(error.localizedDescription)
    }

    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard webView === self.webView else { return }
        failPreparation(error.localizedDescription)
    }

    public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === self.webView else { return }
        dispose("JavaScriptCore 内容进程已退出")
    }

    public static func request(_ json: String, _ callback: @escaping (String, String) -> Void) {
        onMain {
            guard shared.healthy && shared.ready else {
                reply(callback, "", "音源引擎未就绪")
                return
            }
            guard shared.requests.count < 32 else {
                reply(callback, "", "音源网络并发超过 32 个请求")
                return
            }
            do {
                let ticket = UUID()
                let generation = shared.epoch
                let task = try QtSourceHttpTask(json: json) { value, error in
                    onMain {
                        guard shared.epoch == generation else { return }
                        shared.requests.removeValue(forKey: ticket)
                        reply(callback, value, error)
                    }
                }
                shared.requests[ticket] = task
                task.start()
            } catch {
                reply(callback, "", error.localizedDescription)
            }
        }
    }

    public static func dataDir() -> String {
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return directory.appendingPathComponent("QtMusic", isDirectory: true).path
    }

    public static func publicDataDir() -> String {
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Documents")
        return directory.appendingPathComponent("QtMusic", isDirectory: true).path
    }

    private static func sandboxURL(_ path: String, allowBundle: Bool = false) throws -> URL {
        guard !path.isEmpty, !path.utf8.contains(0) else { throw QtSourceError("文件路径为空或包含无效字符") }
        let url: URL
        if path.hasPrefix("file://") {
            guard let value = URL(string: path), value.isFileURL else { throw QtSourceError("文件 URL 无效") }
            url = value
        } else {
            guard path.hasPrefix("/") else { throw QtSourceError("文件路径必须是绝对路径") }
            url = URL(fileURLWithPath: path)
        }
        let result = url.standardizedFileURL.resolvingSymlinksInPath()
        guard !result.path.utf8.contains(0) else { throw QtSourceError("文件路径包含无效字符") }
        let home = URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().path
        let bundle = Bundle.main.bundleURL.resolvingSymlinksInPath().path
        guard result.path.hasPrefix(home + "/") || (allowBundle && result.path.hasPrefix(bundle + "/")) else {
            throw QtSourceError("文件路径必须位于应用沙盒内")
        }
        return result
    }

    private static func readUTF8(_ url: URL) throws -> String {
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= maxBytes else { throw QtSourceError("文本文件超过 8MB 上限") }
        let bytes = try Data(contentsOf: url, options: .mappedIfSafe)
        guard bytes.count <= maxBytes else { throw QtSourceError("文本文件超过 8MB 上限") }
        return String(decoding: bytes, as: UTF8.self)
    }

    /// File operations use a separate serial queue so appends and log rotations keep their ordering.
    public static func fileOperation(_ operation: String, _ path: String, _ value: String,
                                     _ callback: @escaping (String, String, String) -> Void) {
        files.async {
            do {
                let file = try sandboxURL(path, allowBundle: operation == "asset")
                let manager = FileManager.default
                var result = ""
                switch operation {
                case "read", "asset":
                    result = try readUTF8(file)
                case "write":
                    guard value.utf8.count <= maxBytes else { throw QtSourceError("写入文本超过 8MB 上限") }
                    try manager.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try Data(value.utf8).write(to: file, options: .atomic)
                case "append":
                    guard value.utf8.count <= maxBytes else { throw QtSourceError("追加文本超过 8MB 上限") }
                    try manager.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
                    if !manager.fileExists(atPath: file.path) {
                        guard manager.createFile(atPath: file.path, contents: nil) else { throw QtSourceError("无法创建追加文件") }
                    }
                    let handle = try FileHandle(forWritingTo: file)
                    do {
                        try handle.seekToEnd()
                        try handle.write(contentsOf: Data(value.utf8))
                        try handle.close()
                    } catch {
                        try? handle.close()
                        throw error
                    }
                case "rename":
                    let destination = try sandboxURL(value)
                    try manager.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
                    // POSIX rename atomically replaces an existing same-volume file. moveItem
                    // rejects existing destinations, which breaks every later state.json commit.
                    let status = file.path.withCString { source in
                        destination.path.withCString { target in Darwin.rename(source, target) }
                    }
                    if status != 0 { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
                case "exists":
                    result = manager.fileExists(atPath: file.path) ? "1" : "0"
                case "remove":
                    if manager.fileExists(atPath: file.path) { try manager.removeItem(at: file) }
                case "mkdirs":
                    try manager.createDirectory(at: file, withIntermediateDirectories: true)
                case "list":
                    if !manager.fileExists(atPath: file.path) {
                        result = "[]"
                    } else {
                        let entries = try manager.contentsOfDirectory(at: file, includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey])
                        let rows: [[String: Any]] = try entries.map { entry in
                            let values = try entry.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey])
                            return ["name": entry.lastPathComponent, "dir": values.isDirectory ?? false, "size": values.fileSize ?? 0]
                        }
                        result = String(decoding: try JSONSerialization.data(withJSONObject: rows), as: UTF8.self)
                    }
                default:
                    throw QtSourceError("未知文件操作：" + operation)
                }
                DispatchQueue.main.async { callback("1", result, "") }
            } catch {
                let failure = error as NSError
                let missing = (failure.domain == NSCocoaErrorDomain &&
                               (failure.code == NSFileReadNoSuchFileError || failure.code == NSFileNoSuchFileError)) ||
                              (failure.domain == NSPOSIXErrorDomain && failure.code == Int(ENOENT))
                // Stable errno text lets file consumers distinguish first use from a failed read
                // even when the system's localizedDescription is not English.
                let message = missing ? "ENOENT: 文件不存在" : error.localizedDescription
                DispatchQueue.main.async { callback("0", "", message) }
            }
        }
    }

    /// Native trust verification never calls code from the package being verified.
    public static func verifyPackSignature(_ content: String, _ signatureBase64: String, _ publicKeyHex: String,
                                           _ callback: @escaping (String, String, String) -> Void) {
        crypto.async {
            do {
                guard publicKeyHex.utf8.count == 64,
                      let signature = Data(base64Encoded: signatureBase64), signature.count == 64 else {
                    throw QtSourceError("Ed25519 公钥或签名格式错误")
                }
                var publicKey = Data()
                let characters = Array(publicKeyHex.utf8)
                for offset in stride(from: 0, to: characters.count, by: 2) {
                    let pair = String(decoding: characters[offset..<(offset + 2)], as: UTF8.self)
                    guard let byte = UInt8(pair, radix: 16) else { throw QtSourceError("Ed25519 公钥不是十六进制") }
                    publicKey.append(byte)
                }
                let key = try Curve25519.Signing.PublicKey(rawRepresentation: publicKey)
                let valid = key.isValidSignature(signature, for: Data(content.utf8))
                DispatchQueue.main.async { callback("1", valid ? "ok" : "bad", "") }
            } catch {
                DispatchQueue.main.async { callback("0", "", "原生 Ed25519 验签失败：" + error.localizedDescription) }
            }
        }
    }
}

private struct QtSourceError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// A request owns its URLSession, redirect policy and bounded streaming buffer.
/// Cookies/credentials are supplied explicitly by the package, never inherited from Safari.
private final class QtSourceHttpTask: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
    private let callback: (String, String) -> Void
    private let original: URLRequest
    private let manualRedirect: Bool
    private let base64: Bool
    private let lock = NSLock()
    private static let maxBytes = 8 * 1024 * 1024
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var bytes = Data()
    private var response: HTTPURLResponse?
    private var finished = false
    private var redirects = 0

    init(json: String, callback: @escaping (String, String) -> Void) throws {
        guard let data = json.data(using: .utf8),
              let fields = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let address = fields["url"] as? String, let url = URL(string: address),
              Self.allowedURL(url) else { throw QtSourceError("音源 HTTP 地址必须使用 http 或 https") }
        let method = (fields["method"] as? String ?? "GET").uppercased()
        guard !method.isEmpty, method.unicodeScalars.allSatisfy({ CharacterSet.uppercaseLetters.contains($0) }) else {
            throw QtSourceError("HTTP 方法无效")
        }
        let rawTimeout = (fields["timeoutMs"] as? NSNumber)?.doubleValue ?? 15000
        let timeout = rawTimeout.isFinite && rawTimeout > 0 ? min(rawTimeout, 120000) : 15000
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout / 1000)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        let rawHeaders = fields["headers"] as? String ?? ""
        let suppressed = Set(["host", "connection", "content-length", "transfer-encoding", "accept-encoding"])
        for line in rawHeaders.split(separator: "\n") {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = String(line[..<colon]).trimmingCharacters(in: .whitespaces)
            let value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty, !suppressed.contains(name.lowercased()),
                  !name.contains("\r"), !value.contains("\r") else { continue }
            request.setValue(value, forHTTPHeaderField: name)
        }
        if request.value(forHTTPHeaderField: "User-Agent") == nil {
            request.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1",
                             forHTTPHeaderField: "User-Agent")
        }
        if let body = fields["body"] as? String, !body.isEmpty {
            guard body.utf8.count <= Self.maxBytes else { throw QtSourceError("HTTP 请求体超过 8MB 上限") }
            request.httpBody = Data(body.utf8)
        }
        original = request
        manualRedirect = (fields["redirect"] as? String) == "manual"
        base64 = (fields["encoding"] as? String) == "base64"
        self.callback = callback
        super.init()
    }

    private static func allowedURL(_ url: URL) -> Bool {
        return (url.scheme == "http" || url.scheme == "https") &&
            url.host != nil && url.user == nil && url.password == nil
    }

    func start() {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = original.timeoutInterval
        config.timeoutIntervalForResource = original.timeoutInterval
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.qualityOfService = .userInitiated
        let session = URLSession(configuration: config, delegate: self, delegateQueue: queue)
        self.session = session
        let task = session.dataTask(with: original)
        self.task = task
        task.resume()
    }

    func cancel(_ reason: String) {
        complete(reason)
        task?.cancel()
        session?.invalidateAndCancel()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            complete("HTTP 响应格式无效")
            return
        }
        lock.lock()
        self.response = http
        let stopped = finished
        lock.unlock()
        if stopped {
            completionHandler(.cancel)
        } else if original.httpMethod != "HEAD" && http.expectedContentLength > Int64(Self.maxBytes) {
            completionHandler(.cancel)
            complete("HTTP 响应体超过 8MB 上限")
        } else {
            completionHandler(.allow)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        if finished { lock.unlock(); return }
        let excessive = data.count > Self.maxBytes - bytes.count
        if !excessive { bytes.append(data) }
        lock.unlock()
        if excessive {
            complete("HTTP 响应体超过 8MB 上限")
            dataTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        if manualRedirect { completionHandler(nil); return }
        redirects += 1
        guard redirects <= 10, let url = request.url, Self.allowedURL(url) else {
            completionHandler(nil)
            complete("HTTP 重定向无效或超过 10 次上限")
            return
        }
        var next = request
        next.httpShouldHandleCookies = false
        let previous = response.url
        if previous?.scheme != url.scheme || previous?.host != url.host || previous?.port != url.port {
            for header in ["Authorization", "Cookie", "Proxy-Authorization", "X-App-Ut", "X-App-Version", "X-Device", "X-OS"] {
                next.setValue(nil, forHTTPHeaderField: header)
            }
        }
        completionHandler(next)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        complete(error?.localizedDescription ?? "")
    }

    private static func flacBits(_ data: Data) -> Int {
        guard data.count >= 42 else { return 0 }
        let bytes = [UInt8](data.prefix(42))
        guard bytes[0...3].elementsEqual([102, 76, 97, 67]), bytes[4] & 127 == 0,
              bytes[5] == 0, bytes[6] == 0, bytes[7] == 34 else { return 0 }
        let sampleRate = Int(bytes[18]) << 12 | Int(bytes[19]) << 4 | Int(bytes[20]) >> 4
        let bits = ((Int(bytes[20]) & 1) << 4 | Int(bytes[21]) >> 4) + 1
        return sampleRate > 0 && (4...32).contains(bits) ? bits : 0
    }

    private func complete(_ error: String) {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        finished = true
        let body = error.isEmpty ? bytes : Data()
        let http = response
        bytes.removeAll(keepingCapacity: false)
        lock.unlock()
        var headers: [String: String] = [:]
        http?.allHeaderFields.forEach { key, value in headers[String(describing: key).lowercased()] = String(describing: value) }
        let bits = Self.flacBits(body)
        if bits > 0 { headers["x-qt-flac-bits"] = String(bits) }
        let text: String
        if base64 { text = body.base64EncodedString() }
        else if let charset = http?.textEncodingName {
            let encoding = CFStringConvertIANACharSetNameToEncoding(charset as CFString)
            if encoding != kCFStringEncodingInvalidId,
               let decoded = NSString(data: body, encoding: CFStringConvertEncodingToNSStringEncoding(encoding)) {
                text = decoded as String
            } else { text = String(decoding: body, as: UTF8.self) }
        } else { text = String(decoding: body, as: UTF8.self) }
        do {
            let headerData = try JSONSerialization.data(withJSONObject: headers)
            let result: [String: Any] = [
                "statusCode": http?.statusCode ?? 0,
                "headersJson": String(decoding: headerData, as: UTF8.self),
                "body": text,
                "error": error
            ]
            let json = String(decoding: try JSONSerialization.data(withJSONObject: result), as: UTF8.self)
            callback(json, "")
        } catch {
            callback("", error.localizedDescription)
        }
        session?.finishTasksAndInvalidate()
    }
}
