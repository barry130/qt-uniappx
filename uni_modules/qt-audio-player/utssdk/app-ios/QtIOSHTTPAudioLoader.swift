import Foundation
import AVFoundation

/// Public AVAssetResourceLoader integration supplies source Referer headers.
/// Audio remains streamed through URLSession byte ranges; no private AVURLAsset
/// header option or full-track blocking download is needed for local playback.
final class QtIOSHTTPAudioLoader: NSObject, AVAssetResourceLoaderDelegate {
    private let source: URL
    private let referer: String
    private var jobs: [ObjectIdentifier: Job] = [:]

    init(_ source: URL, _ referer: String) {
        self.source = source
        self.referer = referer
    }

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader,
                        shouldWaitForLoadingOfRequestedResource request: AVAssetResourceLoadingRequest) -> Bool {
        let id = ObjectIdentifier(request)
        let job = Job(source, referer, request) { [weak self] in self?.jobs.removeValue(forKey: id) }
        jobs[id] = job
        job.start()
        return true
    }

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader,
                        didCancel request: AVAssetResourceLoadingRequest) {
        jobs.removeValue(forKey: ObjectIdentifier(request))?.cancel()
    }

    func cancel() {
        let active = Array(jobs.values)
        jobs.removeAll()
        active.forEach { $0.cancel() }
    }

    private final class Job: NSObject, URLSessionDataDelegate {
        private let source: URL
        private let referer: String
        private let loading: AVAssetResourceLoadingRequest
        private let completion: () -> Void
        private var session: URLSession?
        private var task: URLSessionDataTask?
        private var cursor: Int64 = 0
        private var ended = false
        private var requestedOffset: Int64 = 0
        private var requestedLength: Int64?
        private var expectedEnd: Int64?

        init(_ source: URL, _ referer: String, _ loading: AVAssetResourceLoadingRequest, _ completion: @escaping () -> Void) {
            self.source = source
            self.referer = referer
            self.loading = loading
            self.completion = completion
        }

        func start() {
            requestedOffset = max(0, loading.dataRequest?.requestedOffset ?? 0)
            if let data = loading.dataRequest, !data.requestsAllDataToEndOfResource {
                requestedLength = Int64(max(0, data.requestedLength))
            }
            var request = URLRequest(url: source)
            request.timeoutInterval = 30
            request.setValue(referer, forHTTPHeaderField: "Referer")
            request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
            if let length = requestedLength, length > 0, requestedOffset <= Int64.max - length {
                request.setValue("bytes=\(requestedOffset)-\(requestedOffset + length - 1)", forHTTPHeaderField: "Range")
            } else { request.setValue("bytes=\(requestedOffset)-", forHTTPHeaderField: "Range") }
            let session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
            self.session = session
            task = session.dataTask(with: request)
            task?.resume()
        }

        func cancel() {
            guard !ended else { return }
            ended = true
            task?.cancel()
            session?.invalidateAndCancel()
            task = nil
            session = nil
        }

        private func finish(_ error: Error? = nil) {
            guard !ended else { return }
            ended = true
            if !loading.isFinished && !loading.isCancelled {
                if let error = error { loading.finishLoading(with: error) } else { loading.finishLoading() }
            }
            task?.cancel()
            session?.finishTasksAndInvalidate()
            task = nil
            session = nil
            completion()
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            guard !ended, let response = response as? HTTPURLResponse,
                  response.statusCode == 200 || response.statusCode == 206 else {
                completionHandler(.cancel)
                finish(NSError(domain: "qt.ios.audio", code: -1, userInfo: [
                    NSLocalizedDescriptionKey: "音源响应无效：HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)"
                ]))
                return
            }
            var total = response.expectedContentLength
            var rangeAvailable = response.value(forHTTPHeaderField: "Accept-Ranges")?.lowercased() == "bytes"
            if response.statusCode == 206 {
                guard let range = response.value(forHTTPHeaderField: "Content-Range"),
                      let bounds = Self.contentRange(range),
                      bounds.start <= requestedOffset, bounds.end >= requestedOffset,
                      response.expectedContentLength < 0
                        || response.expectedContentLength == bounds.end - bounds.start + 1 else {
                    completionHandler(.cancel)
                    finish(NSError(domain: "qt.ios.audio", code: -2,
                                   userInfo: [NSLocalizedDescriptionKey: "音源返回了无效的分段响应"]))
                    return
                }
                cursor = bounds.start
                total = bounds.total
                expectedEnd = bounds.end + 1
                rangeAvailable = true
            } else {
                cursor = 0
                expectedEnd = total > 0 ? total : nil
            }
            if let information = loading.contentInformationRequest {
                information.contentType = Self.contentType(response.mimeType ?? "",
                                                            response.url?.pathExtension ?? source.pathExtension)
                if total > 0 { information.contentLength = total }
                information.isByteRangeAccessSupported = rangeAvailable
            }
            if total > 0, let length = requestedLength {
                requestedLength = min(length, max(0, total - requestedOffset))
            }
            completionHandler(.allow)
            if loading.dataRequest == nil || requestedLength == 0 { finish() }
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            guard !ended, let request = loading.dataRequest else { return }
            let size = Int64(data.count)
            guard cursor <= Int64.max - size else {
                finish(NSError(domain: "qt.ios.audio", code: -3)); return
            }
            let end = cursor + size
            let start = max(request.currentOffset, requestedOffset)
            if end > start {
                let skip = Int(max(0, start - cursor))
                var count = data.count - skip
                if let length = requestedLength {
                    count = Int(min(Int64(count), max(0, length - (start - requestedOffset))))
                }
                if count > 0 { request.respond(with: data.subdata(in: skip..<(skip + count))) }
            }
            cursor = end
            if let length = requestedLength, request.currentOffset - requestedOffset >= length { finish() }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            guard !ended else { return }
            if let length = requestedLength, let request = loading.dataRequest,
               request.currentOffset - requestedOffset < length, error == nil {
                finish(NSError(domain: "qt.ios.audio", code: -4,
                               userInfo: [NSLocalizedDescriptionKey: "音频内容提前结束"]))
            } else if let expectedEnd = expectedEnd, cursor < expectedEnd, error == nil {
                finish(NSError(domain: "qt.ios.audio", code: -4,
                               userInfo: [NSLocalizedDescriptionKey: "音频内容提前结束"]))
            } else { finish(error) }
        }

        private static func contentRange(_ text: String) -> (start: Int64, end: Int64, total: Int64)? {
            let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard value.lowercased().hasPrefix("bytes ") else { return nil }
            let halves = value.dropFirst(6).split(separator: "/", omittingEmptySubsequences: false)
            guard halves.count == 2, let total = Int64(halves[1]), total > 0 else { return nil }
            let bounds = halves[0].split(separator: "-", omittingEmptySubsequences: false)
            guard bounds.count == 2, let start = Int64(bounds[0]), let end = Int64(bounds[1]),
                  start >= 0, end >= start, end < total else { return nil }
            return (start, end, total)
        }

        private static func contentType(_ mime: String, _ suffix: String) -> String {
            switch mime.lowercased() {
            case "audio/mpeg": return AVFileType.mp3.rawValue
            case "audio/mp4", "audio/x-m4a": return AVFileType.m4a.rawValue
            case "audio/wav", "audio/x-wav": return AVFileType.wav.rawValue
            case "audio/aiff", "audio/x-aiff": return AVFileType.aiff.rawValue
            case "audio/x-caf": return AVFileType.caf.rawValue
            case "audio/aac": return "public.aac-audio"
            case "audio/flac", "audio/x-flac": return "org.xiph.flac"
            default:
                switch suffix.lowercased() {
                case "mp3": return AVFileType.mp3.rawValue
                case "m4a", "mp4": return AVFileType.m4a.rawValue
                case "wav": return AVFileType.wav.rawValue
                case "aac": return "public.aac-audio"
                case "flac": return "org.xiph.flac"
                default: return "public.audio"
                }
            }
        }
    }
}
