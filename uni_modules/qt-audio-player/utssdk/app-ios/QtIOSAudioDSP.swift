import Foundation
import AVFoundation
import AudioToolbox
import MediaToolbox

/// AVPlayer's post-effects processing tap changes the actual PCM samples. The
/// system still chooses the decoder/output format; no decoder toggle is claimed.
final class QtIOSAudioDSP {
    static let shared = QtIOSAudioDSP()
    struct Settings {
        var revision: UInt64 = 0
        var equalizer = false
        var levels = [Double](repeating: 0, count: 5)
        var enhance = false
        var gain = 0.0
    }
    private let lock = NSLock()
    private var settings = Settings()

    private func change(_ action: (inout Settings) -> Void) {
        lock.lock()
        action(&settings)
        settings.revision &+= 1
        lock.unlock()
    }
    func snapshot() -> Settings {
        lock.lock()
        let value = settings
        lock.unlock()
        return value
    }
    func setEqualizer(_ enabled: Bool) { change { $0.equalizer = enabled } }
    func setBands(_ json: String) {
        guard let data = json.data(using: .utf8),
              let levels = try? JSONDecoder().decode([Double].self, from: data), levels.count == 5 else { return }
        change { $0.levels = levels.map { max(-12, min(12, $0.isFinite ? $0 : 0)) } }
    }
    func setEnhance(_ enabled: Bool) { change { $0.enhance = enabled } }
    func setGain(_ text: String) {
        let value = Double(text) ?? 0
        change { $0.gain = max(0, min(1800, value.isFinite ? value : 0)) / 100 }
    }

    private final class Context {
        struct Filter {
            var b0 = 1.0, b1 = 0.0, b2 = 0.0, a1 = 0.0, a2 = 0.0
        }
        var rate = 44100.0
        var channels = 2
        var bits: UInt32 = 32
        var floating = true
        var signed = false
        var supported = true
        var revision: UInt64 = UInt64.max
        var filters = [Filter](repeating: Filter(), count: 5)
        var z1: [Double] = []
        var z2: [Double] = []
        var gain = 1.0
        var enabled = false
        var reportSupport: ((Bool) -> Void)?

        func prepare(_ format: AudioStreamBasicDescription) {
            rate = format.mSampleRate
            channels = Int(format.mChannelsPerFrame)
            bits = format.mBitsPerChannel
            floating = format.mFormatFlags & kAudioFormatFlagIsFloat != 0
            signed = format.mFormatFlags & kAudioFormatFlagIsSignedInteger != 0
            let planar = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
            let bytesPerFrame = Int(bits / 8) * (planar ? 1 : channels)
            supported = format.mFormatID == kAudioFormatLinearPCM && rate.isFinite && rate > 0
                && channels > 0 && channels <= 32
                && format.mFormatFlags & kAudioFormatFlagIsBigEndian == 0
                && format.mFormatFlags & kAudioFormatFlagIsAlignedHigh == 0
                && Int(format.mBytesPerFrame) == bytesPerFrame
                && ((floating && (bits == 32 || bits == 64)) || (signed && bits == 16))
            z1 = [Double](repeating: 0, count: max(1, min(32, channels)) * 5)
            z2 = z1
            revision = UInt64.max
            if let report = reportSupport {
                let value = supported
                DispatchQueue.main.async { report(value) }
            }
        }

        func update() {
            let settings = QtIOSAudioDSP.shared.snapshot()
            guard revision != settings.revision else { return }
            revision = settings.revision
            gain = settings.enhance ? pow(10, settings.gain / 20) : 1
            enabled = settings.equalizer || settings.enhance
            let frequencies = [60.0, 230.0, 910.0, 3600.0, 14000.0]
            for band in 0..<5 {
                let decibels = settings.equalizer ? settings.levels[band] : 0
                if abs(decibels) < 0.00001 { filters[band] = Filter(); continue }
                let amplitude = pow(10, decibels / 40)
                let angular = 2 * Double.pi * min(frequencies[band], rate * 0.45) / rate
                let alpha = sin(angular) / 2 // Q = 1
                let cosine = cos(angular)
                let denominator = 1 + alpha / amplitude
                filters[band] = Filter(
                    b0: (1 + alpha * amplitude) / denominator,
                    b1: (-2 * cosine) / denominator,
                    b2: (1 - alpha * amplitude) / denominator,
                    a1: (-2 * cosine) / denominator,
                    a2: (1 - alpha / amplitude) / denominator
                )
            }
            for index in z1.indices { z1[index] = 0; z2[index] = 0 }
        }

        func sample(_ input: Double, _ channel: Int) -> Double {
            var value = input
            for band in 0..<5 {
                let f = filters[band]
                let index = band * channels + channel
                let output = f.b0 * value + z1[index]
                z1[index] = f.b1 * value - f.a1 * output + z2[index]
                z2[index] = f.b2 * value - f.a2 * output
                value = output
            }
            value *= gain
            return value.isFinite ? max(-1, min(1, value)) : 0
        }

        func process(_ list: UnsafeMutablePointer<AudioBufferList>, _ frames: Int) {
            guard supported, frames > 0 else { return }
            update()
            guard enabled else { return }
            var channelOffset = 0
            for buffer in UnsafeMutableAudioBufferListPointer(list) {
                let count = Int(buffer.mNumberChannels)
                guard count > 0, channelOffset + count <= channels, let memory = buffer.mData else { return }
                let bytesPerSample = Int(bits / 8)
                let available = Int(buffer.mDataByteSize) / bytesPerSample / count
                let length = min(frames, available)
                for frame in 0..<length {
                    for channel in 0..<count {
                        let index = frame * count + channel
                        let value: Double
                        if floating && bits == 32 { value = Double(memory.assumingMemoryBound(to: Float.self)[index]) }
                        else if floating { value = memory.assumingMemoryBound(to: Double.self)[index] }
                        else { value = Double(memory.assumingMemoryBound(to: Int16.self)[index]) / 32768 }
                        let output = sample(value, channelOffset + channel)
                        if floating && bits == 32 { memory.assumingMemoryBound(to: Float.self)[index] = Float(output) }
                        else if floating { memory.assumingMemoryBound(to: Double.self)[index] = output }
                        else { memory.assumingMemoryBound(to: Int16.self)[index] = Int16(max(-32768, min(32767, (output * 32768).rounded()))) }
                    }
                }
                channelOffset += count
            }
        }
    }

    /// The tap owns Context through its initialize/finalize storage. Successful
    /// creation consumes exactly one retained context and one retained tap.
    private static func makeMix(_ track: AVAssetTrack, _ reportSupport: @escaping (Bool) -> Void) -> AVAudioMix? {
        let context = Context()
        context.reportSupport = reportSupport
        let retained = Unmanaged.passRetained(context)
        var callbacks = MTAudioProcessingTapCallbacks(
            version: kMTAudioProcessingTapCallbacksVersion_0,
            clientInfo: retained.toOpaque(),
            init: { _, clientInfo, storage in storage.pointee = clientInfo },
            finalize: { tap in
                Unmanaged<Context>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).release()
            },
            prepare: { tap, _, format in
                Unmanaged<Context>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue().prepare(format.pointee)
            },
            unprepare: { _ in },
            process: { tap, frames, _, buffers, outputFrames, outputFlags in
                let result = MTAudioProcessingTapGetSourceAudio(tap, frames, buffers, outputFlags, nil, outputFrames)
                guard result == noErr, outputFrames.pointee > 0 else { return }
                let context = Unmanaged<Context>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
                context.process(buffers, Int(outputFrames.pointee))
            }
        )
        var unmanagedTap: Unmanaged<MTAudioProcessingTap>?
        let status = MTAudioProcessingTapCreate(kCFAllocatorDefault, &callbacks,
                                               kMTAudioProcessingTapCreationFlag_PostEffects, &unmanagedTap)
        guard status == noErr, let tap = unmanagedTap?.takeRetainedValue() else {
            retained.release()
            return nil
        }
        let parameters = AVMutableAudioMixInputParameters(track: track)
        parameters.audioTapProcessor = tap
        let mix = AVMutableAudioMix()
        mix.inputParameters = [parameters]
        return mix
    }

    static func install(_ item: AVPlayerItem, _ current: @escaping () -> Bool, _ done: @escaping (Bool) -> Void) {
        let adopt: ([AVAssetTrack]?) -> Void = { tracks in
            DispatchQueue.main.async {
                guard current() else { return }
                guard let track = tracks?.first, let mix = makeMix(track, { supported in
                    if current() { done(supported) }
                }) else { done(false); return }
                item.audioMix = mix
                done(true)
            }
        }
        if #available(iOS 15.0, *) {
            item.asset.loadTracks(withMediaType: .audio) { tracks, _ in adopt(tracks) }
        } else {
            item.asset.loadValuesAsynchronously(forKeys: ["tracks"]) {
                var error: NSError?
                guard item.asset.statusOfValue(forKey: "tracks", error: &error) == .loaded else { adopt(nil); return }
                adopt(item.asset.tracks(withMediaType: .audio))
            }
        }
    }
}
