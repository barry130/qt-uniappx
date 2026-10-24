"""Verify compiled QtSessionCallback against the configured Media3 AAR.

Usage: python tools/check-media-session-callback.py MEDIA3_SESSION.aar PLUGIN_CLASSES.dex
Checks the real method descriptors and rejects split-dex default-method bridges.
"""
import io
import json
from pathlib import Path
import re
import struct
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CALLBACK = "Landroidx/media3/session/MediaSession$Callback;"
IMPLEMENTATION = "Luts/sdk/modules/qtAudioPlayer/QtSessionCallback;"


def default_methods(aar):
    with zipfile.ZipFile(aar) as archive:
        jar = archive.read("classes.jar")
    with zipfile.ZipFile(io.BytesIO(jar)) as archive:
        data = archive.read("androidx/media3/session/MediaSession$Callback.class")
    pos = 8

    def take(fmt):
        nonlocal pos
        value = struct.unpack_from(">" + fmt, data, pos)[0]
        pos += struct.calcsize(">" + fmt)
        return value

    count = take("H")
    pool = {}
    index = 1
    while index < count:
        tag = take("B")
        if tag == 1:
            length = take("H")
            pool[index] = data[pos:pos + length].decode("utf-8")
            pos += length
        elif tag in (3, 4, 9, 10, 11, 12, 17, 18):
            pos += 4
        elif tag in (5, 6):
            pos += 8
            index += 1
        elif tag in (7, 8, 16, 19, 20):
            pos += 2
        elif tag == 15:
            pos += 3
        else:
            raise AssertionError(f"Unknown class constant tag {tag}")
        index += 1
    pos += 6
    interfaces = take("H")
    pos += interfaces * 2

    def member():
        nonlocal pos
        flags, name, descriptor = take("H"), take("H"), take("H")
        for _ in range(take("H")):
            take("H")
            length = take("I")
            pos += length
        return flags, pool[name], pool[descriptor]

    for _ in range(take("H")):
        member()
    methods = set()
    for _ in range(take("H")):
        flags, name, descriptor = member()
        if flags & 1 and not flags & (0x400 | 8):
            methods.add((name, descriptor))
    return methods


def dex_methods(path):
    data = Path(path).read_bytes()
    assert data[:4] == b"dex\n", "Expected a DEX file"

    def u32(offset):
        return struct.unpack_from("<I", data, offset)[0]

    def u16(offset):
        return struct.unpack_from("<H", data, offset)[0]

    def uleb(offset):
        value, shift = 0, 0
        while True:
            byte = data[offset]
            offset += 1
            value |= (byte & 127) << shift
            if byte < 128:
                return value, offset
            shift += 7

    strings = []
    for i in range(u32(56)):
        offset = u32(u32(60) + i * 4)
        _, offset = uleb(offset)
        strings.append(data[offset:data.index(0, offset)].decode("utf-8", errors="replace"))
    types = [strings[u32(u32(68) + i * 4)] for i in range(u32(64))]
    protos = []
    for i in range(u32(72)):
        offset = u32(76) + i * 12
        params = u32(offset + 8)
        args = "" if not params else "".join(types[u16(params + 4 + j * 2)] for j in range(u32(params)))
        protos.append("(" + args + ")" + types[u32(offset + 4)])
    methods = []
    for i in range(u32(88)):
        offset = u32(92) + i * 8
        methods.append((types[u16(offset)], strings[u32(offset + 4)], protos[u16(offset + 2)]))
    bridges = [item for item in methods if item[0] == CALLBACK[:-1] + "$-CC;"]
    assert not bridges, f"DEX still references missing default-method companion: {bridges}"
    for i in range(u32(96)):
        offset = u32(100) + i * 32
        if types[u32(offset)] != IMPLEMENTATION:
            continue
        cursor = u32(offset + 24)
        sizes = []
        for _ in range(4):
            size, cursor = uleb(cursor)
            sizes.append(size)
        for _ in range(sizes[0] + sizes[1]):
            _, cursor = uleb(cursor)
            _, cursor = uleb(cursor)
        implemented = set()
        for count in sizes[2:]:
            method_index = 0
            for _ in range(count):
                delta, cursor = uleb(cursor)
                method_index += delta
                _, cursor = uleb(cursor)
                code, cursor = uleb(cursor)
                if code:
                    _, name, descriptor = methods[method_index]
                    implemented.add((name, descriptor))
        return implemented
    raise AssertionError("QtSessionCallback is absent from plugin DEX")


def main():
    assert len(sys.argv) == 3, __doc__
    aar, dex = map(Path, sys.argv[1:])
    config = json.loads((ROOT / "uni_modules/qt-audio-player/utssdk/app-android/config.json").read_text(encoding="utf-8"))
    version = next(dep.rsplit(":", 1)[1] for dep in config["dependencies"] if dep.startswith("androidx.media3:media3-session:"))
    assert aar.name == f"media3-session-{version}.aar", "AAR must match configured Media3 version"
    expected = default_methods(aar)
    implemented = dex_methods(dex)
    missing = expected - implemented
    assert not missing, f"Callbacks missing from plugin DEX: {sorted(missing)}"
    source = (ROOT / "uni_modules/qt-audio-player/utssdk/app-android/index.uts").read_text(encoding="utf-8")
    callback = source.split("class QtSessionCallback extends MediaSession.Callback {", 1)[1].split("\nfunction ensureMediaSession", 1)[0]
    callback = re.sub(r"/\*.*?\*/|//[^\n]*", "", callback, flags=re.S)
    assert not re.search(r"\bsuper\s*\.", callback), "Callback must not call interface default implementations"
    print(f"PASS: all {len(expected)} Media3 {version} callback signatures implemented in DEX")
    print("PASS: no MediaSession.Callback$-CC references or interface super calls")


if __name__ == "__main__":
    main()
