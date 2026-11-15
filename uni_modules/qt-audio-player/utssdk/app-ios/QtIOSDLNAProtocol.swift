import Foundation
import Network
import Darwin

struct QtIOSDLNAService {
    let type: String
    let control: URL
    let scpd: URL
}

struct QtIOSDLNADevice {
    let id: String
    let name: String
    let transport: QtIOSDLNAService
    let rendering: QtIOSDLNAService?
    var actions: Set<String>
    var volumeActions: Set<String>
    var minimumVolume = 0.0
    var maximumVolume = 100.0
    var canSeek: Bool { actions.contains("Seek") }
    var canVolume: Bool { rendering != nil && volumeActions.contains("SetVolume") }
}

/// Namespace-independent XML trees keep nested devices/services separate.
/// XMLParser external entity expansion remains disabled.
final class QtIOSXMLNode {
    let name: String
    var text = ""
    var children: [QtIOSXMLNode] = []
    init(_ name: String) { self.name = name.components(separatedBy: ":").last ?? name }
    func child(_ name: String) -> QtIOSXMLNode? { children.first { $0.name == name } }
    func value(_ name: String) -> String { child(name)?.text.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" }
    func descendants(_ name: String) -> [QtIOSXMLNode] {
        children.flatMap { ($0.name == name ? [$0] : []) + $0.descendants(name) }
    }
}

final class QtIOSXMLParser: NSObject, XMLParserDelegate {
    private let root = QtIOSXMLNode("root")
    private var stack: [QtIOSXMLNode] = []
    private var count = 0
    private var invalid = false

    static func parse(_ data: Data) -> QtIOSXMLNode? {
        guard data.count <= 1024 * 1024 else { return nil }
        let delegate = QtIOSXMLParser()
        let parser = XMLParser(data: data)
        parser.shouldResolveExternalEntities = false
        parser.delegate = delegate
        delegate.stack = [delegate.root]
        return parser.parse() && !delegate.invalid ? delegate.root : nil
    }

    func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?,
                qualifiedName: String?, attributes: [String: String] = [:]) {
        count += 1
        if stack.count >= 64 || count > 10000 { invalid = true; parser.abortParsing(); return }
        let node = QtIOSXMLNode(name)
        stack.last?.children.append(node)
        stack.append(node)
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) { stack.last?.text += string }
    func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
        if stack.count > 1 { stack.removeLast() }
    }
}

enum QtIOSDLNAProtocol {
    static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }

    static func time(_ seconds: Double) -> String {
        let value = Int(max(0, min(359999, seconds.isFinite ? seconds : 0)))
        return String(format: "%02d:%02d:%02d", value / 3600, value / 60 % 60, value % 60)
    }

    static func seconds(_ value: String) -> Double {
        let parts = value.split(separator: ":").compactMap { Double($0) }
        guard parts.count == 3, parts.allSatisfy({ $0.isFinite && $0 >= 0 }),
              parts[1] < 60, parts[2] < 60 else { return 0 }
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    }

    static func device(_ data: Data, _ location: URL) -> QtIOSDLNADevice? {
        guard let root = QtIOSXMLParser.parse(data),
              let renderer = root.descendants("device").first(where: {
                  $0.value("deviceType").contains(":MediaRenderer:")
              }),
              let serviceList = renderer.child("serviceList") else { return nil }
        let declaredBase = root.descendants("URLBase").first?.text.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let base = URL(string: declaredBase, relativeTo: location)?.absoluteURL ?? location
        let services = serviceList.children.compactMap { node -> QtIOSDLNAService? in
            guard let control = URL(string: node.value("controlURL"), relativeTo: base)?.absoluteURL,
                  let scpd = URL(string: node.value("SCPDURL"), relativeTo: base)?.absoluteURL,
                  ["http", "https"].contains(control.scheme?.lowercased() ?? ""),
                  ["http", "https"].contains(scpd.scheme?.lowercased() ?? "") else { return nil }
            return QtIOSDLNAService(type: node.value("serviceType"), control: control, scpd: scpd)
        }
        guard let transport = services.first(where: { $0.type.contains(":AVTransport:") }) else { return nil }
        let id = renderer.value("UDN").isEmpty ? location.absoluteString : renderer.value("UDN")
        let name = renderer.value("friendlyName").isEmpty ? "DLNA 播放设备" : renderer.value("friendlyName")
        return QtIOSDLNADevice(id: id, name: name, transport: transport,
                              rendering: services.first(where: { $0.type.contains(":RenderingControl:") }),
                              actions: [], volumeActions: [])
    }

    static func mime(_ data: Data, _ fallback: String = "application/octet-stream") -> String {
        let bytes = [UInt8](data.prefix(32))
        if bytes.starts(with: [0x49, 0x44, 0x33]) || (bytes.count > 1 && bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0) {
            return bytes.count > 1 && bytes[1] & 0xf6 == 0xf0 ? "audio/aac" : "audio/mpeg"
        }
        if bytes.starts(with: Array("fLaC".utf8)) { return "audio/flac" }
        if bytes.starts(with: Array("OggS".utf8)) { return "audio/ogg" }
        if bytes.count >= 12, bytes.starts(with: Array("RIFF".utf8)), Array(bytes[8..<12]) == Array("WAVE".utf8) {
            return "audio/wav"
        }
        if bytes.count >= 8, Array(bytes[4..<8]) == Array("ftyp".utf8) { return "audio/mp4" }
        if bytes.count >= 12, bytes.starts(with: Array("FORM".utf8)),
           ["AIFF", "AIFC"].contains(String(bytes: bytes[8..<12], encoding: .ascii) ?? "") { return "audio/aiff" }
        return fallback.lowercased().hasPrefix("audio/") ? fallback : "application/octet-stream"
    }

    static func wifiAddress() -> String? {
        var first: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&first) == 0 else { return nil }
        defer { freeifaddrs(first) }
        var current = first
        var addresses: [(String, String)] = []
        while let node = current {
            defer { current = node.pointee.ifa_next }
            guard let address = node.pointee.ifa_addr, address.pointee.sa_family == UInt8(AF_INET),
                  node.pointee.ifa_flags & UInt32(IFF_UP) != 0 else { continue }
            let name = String(cString: node.pointee.ifa_name)
            guard name.hasPrefix("en") else { continue }
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(address, socklen_t(address.pointee.sa_len), &buffer, socklen_t(buffer.count),
                           nil, 0, NI_NUMERICHOST) == 0 {
                let ip = String(cString: buffer)
                if !ip.hasPrefix("127.") && !ip.hasPrefix("169.254.") { addresses.append((name, ip)) }
            }
        }
        return addresses.first(where: { $0.0 == "en0" })?.1 ?? addresses.first?.1
    }

    static func discoverLocations(_ ip: String) -> ([URL], String) {
        let socketFD = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard socketFD >= 0 else { return ([], "无法建立 DLNA 发现连接") }
        defer { Darwin.close(socketFD) }
        var reuse: Int32 = 1
        _ = setsockopt(socketFD, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout.size(ofValue: reuse)))
        var wait = timeval(tv_sec: 1, tv_usec: 0)
        _ = setsockopt(socketFD, SOL_SOCKET, SO_RCVTIMEO, &wait, socklen_t(MemoryLayout.size(ofValue: wait)))
        var local = sockaddr_in()
        local.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        local.sin_family = sa_family_t(AF_INET)
        local.sin_port = 0
        _ = inet_pton(AF_INET, ip, &local.sin_addr)
        let bound = withUnsafePointer(to: &local) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(socketFD, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0 else { return ([], "当前局域网地址不可用") }
        var outgoing = local.sin_addr
        _ = setsockopt(socketFD, IPPROTO_IP, IP_MULTICAST_IF, &outgoing, socklen_t(MemoryLayout<in_addr>.size))
        var remote = sockaddr_in()
        remote.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        remote.sin_family = sa_family_t(AF_INET)
        remote.sin_port = UInt16(1900).bigEndian
        _ = inet_pton(AF_INET, "239.255.255.250", &remote.sin_addr)
        var locations = Set<String>()
        var buffer = [UInt8](repeating: 0, count: 16384)
        let started = ProcessInfo.processInfo.systemUptime
        var lastSent = -10.0
        while ProcessInfo.processInfo.systemUptime - started < 5 {
            let elapsed = ProcessInfo.processInfo.systemUptime - started
            if elapsed - lastSent >= 2 {
                lastSent = elapsed
                for target in ["urn:schemas-upnp-org:device:MediaRenderer:1", "ssdp:all"] {
                    let message = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: \(target)\r\n\r\n"
                    let sent = message.withCString { bytes in
                        withUnsafePointer(to: &remote) {
                            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                                sendto(socketFD, bytes, message.utf8.count, 0, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                            }
                        }
                    }
                    if sent < 0 && (errno == EPERM || errno == EACCES) {
                        return ([], "请允许本地网络访问；iOS 构建还需开启 multicast entitlement")
                    }
                }
            }
            let count = recv(socketFD, &buffer, buffer.count, 0)
            guard count > 0, let text = String(bytes: buffer.prefix(count), encoding: .utf8),
                  text.uppercased().hasPrefix("HTTP/1.1 200") else { continue }
            for line in text.components(separatedBy: "\r\n") {
                guard let colon = line.firstIndex(of: ":"), line[..<colon].lowercased() == "location" else { continue }
                let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                if let url = URL(string: value), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                    locations.insert(url.absoluteString)
                }
            }
            if locations.count >= 128 { break }
        }
        return (locations.compactMap(URL.init(string:)), "")
    }
}

/// Token-protected local HTTP media server. Every route is a complete file, so
/// GET, HEAD and a single byte range share exactly the same measured length.
final class QtIOSDLNAMediaServer {
    struct Asset {
        let file: QtIOSScopedFile
        let mime: String
        let bytes: UInt64
    }
    private let queue = DispatchQueue(label: "qt.dlna.http", qos: .utility)
    private var listener: NWListener?
    private var clients: [ObjectIdentifier: NWConnection] = [:]
    private var awaitingHeaders = Set<ObjectIdentifier>()
    private var assets: [String: Asset] = [:]
    private var address = ""
    private var port: UInt16 = 0

    func start(_ address: String, _ callback: @escaping (Bool) -> Void) {
        queue.async {
            self.address = address
            do {
                let listener = try NWListener(using: .tcp, on: .any)
                self.listener = listener
                listener.stateUpdateHandler = { [weak self, weak listener] state in
                    guard let self = self, let listener = listener else { return }
                    if case .ready = state {
                        self.port = listener.port?.rawValue ?? 0
                        DispatchQueue.main.async { callback(self.port > 0) }
                    } else if case .failed = state {
                        DispatchQueue.main.async { callback(false) }
                    }
                }
                listener.newConnectionHandler = { [weak self] in self?.accept($0) }
                listener.start(queue: self.queue)
            } catch { DispatchQueue.main.async { callback(false) } }
        }
    }

    func register(_ token: String, _ generation: UInt64, _ file: QtIOSScopedFile,
                  _ mime: String, _ bytes: UInt64) -> String {
        queue.sync {
            let route = "/qt-dlna/\(token)/\(generation)/song"
            assets = [route: Asset(file: file, mime: mime, bytes: bytes)]
            return "http://\(address):\(port)\(route)"
        }
    }

    func stop() {
        queue.async {
            self.listener?.cancel()
            self.listener = nil
            self.assets.removeAll()
            for client in self.clients.values { client.cancel() }
            self.clients.removeAll()
            self.awaitingHeaders.removeAll()
        }
    }

    func invalidateRoutes() { queue.async { self.assets.removeAll() } }

    private func accept(_ connection: NWConnection) {
        let id = ObjectIdentifier(connection)
        clients[id] = connection
        awaitingHeaders.insert(id)
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            if case .failed = state { self?.clients.removeValue(forKey: id); connection?.cancel() }
            if case .cancelled = state { self?.clients.removeValue(forKey: id); self?.awaitingHeaders.remove(id) }
        }
        connection.start(queue: queue)
        readRequest(connection, Data())
        queue.asyncAfter(deadline: .now() + 15) { [weak self, weak connection] in
            guard let self = self, self.awaitingHeaders.contains(id) else { return }
            connection?.cancel()
        }
    }

    private func readRequest(_ connection: NWConnection, _ previous: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, complete, error in
            var request = previous
            if let data = data { request.append(data) }
            if let end = request.range(of: Data("\r\n\r\n".utf8)) {
                self.respond(connection, Data(request[..<end.lowerBound]))
            } else if request.count >= 32768 || error != nil || complete {
                self.error(connection, 400, "Bad Request")
            } else { self.readRequest(connection, request) }
        }
    }

    private func respond(_ connection: NWConnection, _ data: Data) {
        awaitingHeaders.remove(ObjectIdentifier(connection))
        guard let text = String(data: data, encoding: .utf8) else { error(connection, 400, "Bad Request"); return }
        let lines = text.components(separatedBy: "\r\n")
        let first = (lines.first ?? "").split(separator: " ")
        guard first.count == 3 else { error(connection, 400, "Bad Request"); return }
        let method = String(first[0])
        guard method == "GET" || method == "HEAD" else { error(connection, 405, "Method Not Allowed"); return }
        let route = String(first[1]).components(separatedBy: "?")[0]
        guard let asset = assets[route] else { error(connection, 404, "Not Found"); return }
        var range: String?
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            if line[..<colon].lowercased() == "range" {
                if range != nil { error(connection, 416, "Range Not Satisfiable", asset.bytes); return }
                range = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            }
        }
        let bounds: (UInt64, UInt64)
        if let range = range {
            guard let parsed = Self.byteRange(range, asset.bytes) else {
                error(connection, 416, "Range Not Satisfiable", asset.bytes); return
            }
            bounds = parsed
        } else { bounds = (0, asset.bytes - 1) }
        guard let file = try? FileHandle(forReadingFrom: asset.file.url) else { error(connection, 404, "Not Found"); return }
        let length = bounds.1 - bounds.0 + 1
        let partial = range != nil
        var headers = "HTTP/1.1 \(partial ? "206 Partial Content" : "200 OK")\r\nContent-Type: \(asset.mime)\r\nContent-Length: \(length)\r\nAccept-Ranges: bytes\r\nConnection: close\r\ntransferMode.dlna.org: Streaming\r\ncontentFeatures.dlna.org: DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000\r\n"
        if partial { headers += "Content-Range: bytes \(bounds.0)-\(bounds.1)/\(asset.bytes)\r\n" }
        headers += "\r\n"
        if method == "HEAD" {
            connection.send(content: Data(headers.utf8), completion: .contentProcessed { _ in
                try? file.close(); connection.cancel()
            })
            return
        }
        do { try file.seek(toOffset: bounds.0) } catch {
            try? file.close(); error(connection, 500, "Read Failed"); return
        }
        connection.send(content: Data(headers.utf8), completion: .contentProcessed { error in
            if error != nil { try? file.close(); connection.cancel(); return }
            self.sendFile(connection, file, length, asset.file)
        })
    }

    private func sendFile(_ connection: NWConnection, _ file: FileHandle, _ remaining: UInt64, _ scope: QtIOSScopedFile) {
        if remaining == 0 { try? file.close(); connection.cancel(); return }
        guard let data = try? file.read(upToCount: Int(min(65536, remaining))), !data.isEmpty else {
            try? file.close(); connection.cancel(); return
        }
        connection.send(content: data, completion: .contentProcessed { error in
            if error != nil { try? file.close(); connection.cancel(); return }
            self.sendFile(connection, file, remaining - UInt64(data.count), scope)
        })
    }

    private func error(_ connection: NWConnection, _ status: Int, _ phrase: String, _ length: UInt64? = nil) {
        var headers = "HTTP/1.1 \(status) \(phrase)\r\nContent-Length: 0\r\nConnection: close\r\n"
        if let length = length { headers += "Content-Range: bytes */\(length)\r\n" }
        connection.send(content: Data((headers + "\r\n").utf8), completion: .contentProcessed { _ in connection.cancel() })
    }

    static func byteRange(_ value: String, _ size: UInt64) -> (UInt64, UInt64)? {
        guard size > 0, value.lowercased().hasPrefix("bytes="), !value.contains(",") else { return nil }
        let parts = value.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        if parts[0].isEmpty {
            guard let suffix = UInt64(parts[1]), suffix > 0 else { return nil }
            return (size - min(size, suffix), size - 1)
        }
        guard let start = UInt64(parts[0]), start < size else { return nil }
        if parts[1].isEmpty { return (start, size - 1) }
        guard let end = UInt64(parts[1]), end >= start else { return nil }
        return (start, min(end, size - 1))
    }
}
