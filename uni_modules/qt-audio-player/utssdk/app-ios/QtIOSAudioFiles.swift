import Foundation

/// Shared directory bookmark contract with qt-app-native. Keep the scope alive
/// for the complete AVPlayer/HTTP reader lifetime, including asynchronous reads.
final class QtIOSScopedFile {
    let url: URL
    private let scope: URL?

    private init(_ url: URL, _ scope: URL?) {
        self.url = url
        self.scope = scope
    }

    deinit { scope?.stopAccessingSecurityScopedResource() }

    static func open(_ original: URL) -> QtIOSScopedFile? {
        guard original.isFileURL else { return nil }
        let normalized = original.standardizedFileURL
        let sandbox = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true).standardizedFileURL
        if contains(sandbox, normalized) { return QtIOSScopedFile(normalized, nil) }
        let key = "qt-ios-folder-bookmarks-v1"
        let defaults = UserDefaults.standard
        var bookmarks = defaults.dictionary(forKey: key) ?? [:]
        let matches = bookmarks.keys.filter { value in
            guard let directory = URL(string: value), directory.isFileURL else { return false }
            return contains(directory.standardizedFileURL, normalized)
        }.sorted { $0.count > $1.count }
        for originalKey in matches {
            guard let bookmark = bookmarks[originalKey] as? Data,
                  let oldRoot = URL(string: originalKey)?.standardizedFileURL else { continue }
            var stale = false
            guard let root = try? URL(resolvingBookmarkData: bookmark, options: [.withoutUI],
                                      relativeTo: nil, bookmarkDataIsStale: &stale),
                  root.startAccessingSecurityScopedResource() else { continue }
            let relative = String(normalized.path.dropFirst(oldRoot.path.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let restored = relative.isEmpty ? root : root.appendingPathComponent(relative)
            guard contains(root.standardizedFileURL, restored.standardizedFileURL) else {
                root.stopAccessingSecurityScopedResource()
                continue
            }
            if stale, let updated = try? root.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
                bookmarks[originalKey] = updated
                defaults.set(bookmarks, forKey: key)
            }
            return QtIOSScopedFile(restored.standardizedFileURL, root)
        }
        // Documents imported with a file bookmark can carry the scope directly.
        guard normalized.startAccessingSecurityScopedResource() else { return nil }
        return QtIOSScopedFile(normalized, normalized)
    }

    private static func contains(_ parent: URL, _ child: URL) -> Bool {
        let root = parent.standardizedFileURL.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let path = child.standardizedFileURL.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return path == root || path.hasPrefix(root + "/")
    }
}

enum QtIOSAudioOccurrence {
    static func index(_ old: [String], _ previous: Int, _ new: [String], _ mediaID: String) -> Int? {
        let matches = new.indices.filter { new[$0] == mediaID }
        guard !matches.isEmpty else { return nil }
        if previous >= 0, previous < old.count, old[previous] == mediaID {
            let ordinal = old.prefix(previous + 1).filter { $0 == mediaID }.count - 1
            if ordinal >= 0, ordinal < matches.count { return matches[ordinal] }
        }
        return matches.min { abs($0 - previous) < abs($1 - previous) }
    }
}
