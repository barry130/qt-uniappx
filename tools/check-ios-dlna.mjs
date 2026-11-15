// Swift SOURCE contracts only. No Swift is executed or translated to JS.
// Run check-ios-audio.mjs separately for UTS facade compatibility evidence.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'uni_modules/qt-audio-player/utssdk/app-ios/QtIOSDLNA.swift'), 'utf8').replace(/\r\n/g, '\n');
function method(signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const remainder = source.slice(start + signature.length);
  const end = remainder.search(/\n    (?:public|private) func /);
  return source.slice(start, end < 0 ? source.length : start + signature.length + end);
}
function has(text, pattern, detail) { assert.ok(pattern.test(text), detail || String(pattern)); }
const poll = method('private func poll()');
const transportAt = poll.indexOf('self.enqueue(device.transport, "GetTransportInfo"');
const transport = poll.slice(transportAt);
const terminal = poll.slice(poll.indexOf('} else if state == "STOPPED"'));
const checks = [
  ['raw PLAYING evidence carries identity control revisions position and monotonic time', () => {
    has(source, /struct PlayingEvidence/);
    for (const field of ['session: UInt64', 'generation: UInt64', 'playback: UInt64', 'seek: UInt64', 'control: UInt64', 'uri: String', 'position: Double', 'monotonic: Double']) assert.ok(source.includes(`let ${field}`), field);
    has(poll, /let sampledAt = ProcessInfo\.processInfo\.systemUptime/);
    has(poll, /position: rawPosition, monotonic: sampledAt/);
  }],
  ['both SOAP request and reply gates include playback seek control and poll identity', () => {
    const valid = method('private func matchesPoll(');
    for (const part of ['matches(s, g)', 'playbackRevision == playback', 'seekRevision == seek', 'controlRevision == control', 'pollSequence == poll', 'pollBusy']) assert.ok(valid.includes(part), part);
    assert.equal((poll.match(/self\.matchesPoll\(s, g, playback, seek, control, pollID\)/g) || []).length, 4);
    has(method('private func finishPoll('), /matches\(s, g\) && pollSequence == poll/);
  }],
  ['no partial position duration or phase commit before second reply succeeds', () => {
    assert.ok(transportAt > 0);
    assert.ok(!/self\.(?:position|duration|phase|lastDevicePosition) =/.test(poll.slice(0, transportAt)));
    assert.ok(transport.indexOf('guard success else') < transport.indexOf('self.duration = rawDuration'));
    has(transport, /let currentPosition = rawPosition \?\? 0/);
    has(method('private func deviceSeconds('), /return value\.isFinite \? value : nil/);
  }],
  ['nonempty same URI and positive raw position qualify PLAYING; load and Play acknowledgement do not', () => {
    has(poll, /if !uri\.isEmpty && !self\.uriMatchesMedia\(uri\)/);
    has(poll, /if !uri\.isEmpty, let rawPosition = rawPosition, rawPosition > 0,/);
    has(poll, /self\.intent, !self\.manuallyStopped, self\.deferredSeek == nil/);
    assert.equal((source.match(/lastConfirmedPlaying = PlayingEvidence/g) || []).length, 1);
    assert.ok(!method('private func driveTransport(').includes('lastConfirmedPlaying ='));
  }],
  ['STOPPED and NO_MEDIA consume evidence before deciding; empty URI alone does not qualify', () => {
    has(terminal, /state == "STOPPED" \|\| state == "NO_MEDIA_PRESENT"/);
    has(terminal, /let evidence = self\.lastConfirmedPlaying\n\s+self\.revokePlayingEvidence\(\)\n\s+if self\.intent/);
    has(terminal, /let evidence = evidence/);
    has(terminal, /self\.uriMatchesMedia\(evidence\.uri\)/);
    has(terminal, /\(uri\.isEmpty \|\| self\.uriMatchesMedia\(uri\)\)/);
  }],
  ['bounded extrapolation uses confirmed raw position current valid sample and 1800ms tail', () => {
    has(terminal, /self\.duration > 2/);
    has(terminal, /elapsed >= 0, elapsed <= 5/);
    has(terminal, /let candidate = min\(self\.duration, max\(evidence\.position \+ elapsed, currentPosition\)\)/);
    has(terminal, /self\.duration - candidate <= 1\.8/);
    for (const part of ['evidence.session == s', 'evidence.generation == g', 'evidence.playback == playback', 'evidence.seek == seek', 'evidence.control == control']) assert.ok(terminal.includes(part), part);
  }],
  ['load pause play seek Stop error and deferred seek revoke evidence', () => {
    has(method('private func retireMedia('), /revokePlayingEvidence\(\)/);
    for (const sig of ['private func load(', 'public func stop()']) has(method(sig), /retireMedia\(\)/, sig);
    for (const sig of ['public func play()', 'public func pause()', 'public func seek(', 'private func fail(', 'private func seekAfterPrepare(']) has(method(sig), /revokePlayingEvidence\(\)/, sig);
    has(method('public func stop()'), /manuallyStopped = true/);
  }],
  ['pause transition unknown state and foreign URI revoke qualification', () => {
    for (const state of ['PAUSED_PLAYBACK', 'TRANSITIONING']) has(poll, new RegExp(`state == "${state}" \\{\\n\\s+self\\.revokePlayingEvidence\\(\\)`));
    has(poll, /\} else \{\n\s+self\.revokePlayingEvidence\(\)\n\s+self\.phase = "connected"/);
    has(poll, /if !uri\.isEmpty && !self\.uriMatchesMedia\(uri\) \{\n\s+self\.revokePlayingEvidence\(\)/);
  }],
  ['both errors revoke and count; complete successful poll resets failures', () => {
    assert.equal((poll.match(/self\.pollFailures \+= 1/g) || []).length, 2);
    assert.equal((poll.match(/self\.pollFailures = 0/g) || []).length, 1);
    assert.ok(transport.indexOf('self.pollFailures = 0') > transport.indexOf('guard success else'));
  }],
  ['completion is consumed before original native queue and repeat policy', () => {
    const advance = method('private func advanceNatural()');
    has(advance, /guard !endConsumed else \{ return \}\n\s+endConsumed = true\n\s+revokePlayingEvidence\(\)/);
    for (const part of ['load(index, 0, true, true)', 'load(index + 1, 0, true, true)', 'load(0, 0, true, true)', 'reportRemoteEnded()']) assert.ok(advance.includes(part), part);
    has(method('private func retireMedia('), /endConsumed = false/);
  }],
  ['late seek receipt checks controls before any position write', () => {
    const seek = method('private func seekAfterPrepare(');
    has(seek, /guard self\.matches\(s, g\), self\.seekRevision == revision,/);
    has(seek, /self\.playbackRevision == playback, self\.controlRevision == control else/);
  }],
  ['volume remains independent and historical maximum position is removed', () => {
    const volume = method('public func setVolume(');
    assert.ok(!/controlRevision|playbackRevision|seekRevision|revokePlayingEvidence/.test(volume));
    assert.ok(!/sawPlaying|lastMovingPosition/.test(source));
    has(poll, /self\.lastDevicePosition = rawPosition/);
  }],
];
let failed = 0;
for (const [name, run] of checks) {
  try { run(); console.log(`PASS iOS DLNA source: ${name}`); }
  catch (error) { failed++; console.error(`FAIL iOS DLNA source: ${name}: ${error.message}`); }
}
console.log(`iOS DLNA source contracts: ${checks.length - failed}/${checks.length}; Swift execution and Apple SDK compilation NOT RUN`);
if (failed) process.exitCode = 1;
