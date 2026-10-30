// Reads title, author, cover art and chapters from audiobook files without
// loading the whole file into memory. Supports M4B/M4A/MP4 (Nero "chpl" atom
// and QuickTime chapter tracks) and MP3 (ID3v2 CHAP frames).
// Written in ES2017 so it runs on older Chrome builds.

var BookMeta = (function () {
  'use strict';

  function readBytes(blob, start, len) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(new DataView(r.result)); };
      r.onerror = function () { reject(r.error); };
      r.readAsArrayBuffer(blob.slice(start, start + len));
    });
  }

  function str(dv, o, n) {
    var s = '';
    for (var i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(o + i));
    return s;
  }
  function u64(dv, o) { return dv.getUint32(o) * 4294967296 + dv.getUint32(o + 4); }
  function bytes(dv, s, e) { return new Uint8Array(dv.buffer, dv.byteOffset + s, Math.max(0, e - s)); }

  function decode(arr, label) {
    try { return new TextDecoder(label).decode(arr); } catch (e) { return ''; }
  }

  // ---------- MP4 / M4B ----------

  function boxes(dv, start, end) {
    var out = [], p = start;
    while (p + 8 <= end) {
      var size = dv.getUint32(p), type = str(dv, p + 4, 4), hdr = 8;
      if (size === 1) { size = u64(dv, p + 8); hdr = 16; }
      else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) break;
      out.push({ type: type, start: p + hdr, end: p + size });
      p += size;
    }
    return out;
  }

  function find(dv, box, path) {
    var cur = box;
    for (var i = 0; i < path.length && cur; i++) {
      var start = cur.start;
      if (path[i - 1] === 'meta' || (i === 0 && cur.type === 'meta')) start = metaStart(dv, cur);
      var kids = boxes(dv, start, cur.end), next = null;
      for (var k = 0; k < kids.length; k++) if (kids[k].type === path[i]) { next = kids[k]; break; }
      cur = next;
    }
    return cur;
  }

  // "meta" is a full box in MP4 files but a plain container in some QuickTime files.
  function metaStart(dv, meta) {
    if (meta.start + 12 <= meta.end && str(dv, meta.start + 8, 4) === 'hdlr') return meta.start + 4;
    return meta.start;
  }

  async function topLevelBox(file, type) {
    var pos = 0;
    while (pos + 8 <= file.size) {
      var h = await readBytes(file, pos, 16);
      var size = h.getUint32(0), t = str(h, 4, 4), hdr = 8;
      if (size === 1) { size = u64(h, 8); hdr = 16; }
      else if (size === 0) size = file.size - pos;
      if (size < hdr) return null;
      if (t === type) return { start: pos, size: size };
      pos += size;
    }
    return null;
  }

  function parseChpl(dv, box) {
    var p = box.start, version = dv.getUint8(p);
    p += 4;
    if (version) p += 4;
    var count = dv.getUint8(p++), out = [];
    for (var i = 0; i < count && p + 9 <= box.end; i++) {
      var start = u64(dv, p) / 1e7, len = dv.getUint8(p + 8);
      p += 9;
      out.push({ start: start, title: decode(bytes(dv, p, Math.min(p + len, box.end)), 'utf-8') });
      p += len;
    }
    return out;
  }

  function trackInfo(dv, trak) {
    var info = { id: 0, chapRefs: [], handler: '', timescale: 0, trak: trak };
    var tkhd = find(dv, trak, ['tkhd']);
    if (tkhd) info.id = dv.getUint32(tkhd.start + (dv.getUint8(tkhd.start) === 1 ? 20 : 12));
    var chap = find(dv, trak, ['tref', 'chap']);
    if (chap) for (var p = chap.start; p + 4 <= chap.end; p += 4) info.chapRefs.push(dv.getUint32(p));
    var hdlr = find(dv, trak, ['mdia', 'hdlr']);
    if (hdlr) info.handler = str(dv, hdlr.start + 8, 4);
    var mdhd = find(dv, trak, ['mdia', 'mdhd']);
    if (mdhd) info.timescale = dv.getUint32(mdhd.start + (dv.getUint8(mdhd.start) === 1 ? 20 : 12));
    return info;
  }

  async function readChapterTrack(file, dv, track) {
    var stbl = find(dv, track.trak, ['mdia', 'minf', 'stbl']);
    if (!stbl || !track.timescale) return [];
    var stts = find(dv, stbl, ['stts']), stsz = find(dv, stbl, ['stsz']);
    var stsc = find(dv, stbl, ['stsc']), stco = find(dv, stbl, ['stco']), co64 = find(dv, stbl, ['co64']);
    if (!stts || !stsz || !stsc || !(stco || co64)) return [];

    var starts = [], t = 0, n, i, j, p;
    n = dv.getUint32(stts.start + 4);
    for (i = 0, p = stts.start + 8; i < n; i++, p += 8) {
      var count = dv.getUint32(p), delta = dv.getUint32(p + 4);
      for (j = 0; j < count; j++) { starts.push(t); t += delta; }
    }

    var fixed = dv.getUint32(stsz.start + 4), sampleCount = dv.getUint32(stsz.start + 8), sizes = [];
    for (i = 0; i < sampleCount; i++) sizes.push(fixed || dv.getUint32(stsz.start + 12 + i * 4));

    var chunks = [], co = stco || co64;
    n = dv.getUint32(co.start + 4);
    for (i = 0; i < n; i++) chunks.push(stco ? dv.getUint32(co.start + 8 + i * 4) : u64(dv, co.start + 8 + i * 8));

    var runs = [];
    n = dv.getUint32(stsc.start + 4);
    for (i = 0, p = stsc.start + 8; i < n; i++, p += 12) runs.push({ first: dv.getUint32(p), perChunk: dv.getUint32(p + 4) });

    var offsets = [], s = 0;
    for (i = 0; i < runs.length; i++) {
      var last = i + 1 < runs.length ? runs[i + 1].first : chunks.length + 1;
      for (var c = runs[i].first; c < last && c <= chunks.length; c++) {
        var off = chunks[c - 1];
        for (j = 0; j < runs[i].perChunk && s < sizes.length; j++) { offsets[s] = off; off += sizes[s]; s++; }
      }
    }

    var out = [];
    for (i = 0; i < offsets.length && i < starts.length; i++) {
      var title = '';
      if (sizes[i] >= 2) {
        var sample = await readBytes(file, offsets[i], sizes[i]);
        var len = Math.min(sample.getUint16(0), sizes[i] - 2);
        var text = bytes(sample, 2, 2 + len);
        title = (text[0] === 0xfe && text[1] === 0xff) ? decode(text.subarray(2), 'utf-16be') : decode(text, 'utf-8');
      }
      out.push({ start: starts[i] / track.timescale, title: title });
    }
    return out;
  }

  function ilstText(dv, ilst, key) {
    var data = ilst && find(dv, ilst, [key, 'data']);
    return data ? decode(bytes(dv, data.start + 8, data.end), 'utf-8').trim() : '';
  }

  async function parseMp4(file) {
    var loc = await topLevelBox(file, 'moov');
    if (!loc || loc.size > 200 * 1024 * 1024) return null;
    var dv = await readBytes(file, loc.start, loc.size);
    var moov = boxes(dv, 0, dv.byteLength)[0];
    if (!moov || moov.type !== 'moov') return null;
    var meta = { title: '', author: '', cover: null, chapters: [] };

    var ilst = find(dv, moov, ['udta', 'meta', 'ilst']) || find(dv, moov, ['meta', 'ilst']);
    if (ilst) {
      meta.title = ilstText(dv, ilst, '©nam') || ilstText(dv, ilst, '©alb');
      meta.author = ilstText(dv, ilst, '©ART') || ilstText(dv, ilst, 'aART') || ilstText(dv, ilst, '©wrt');
      var covr = find(dv, ilst, ['covr', 'data']);
      if (covr && covr.end - covr.start > 8) {
        var kind = dv.getUint32(covr.start) & 0xffffff;
        meta.cover = new Blob([bytes(dv, covr.start + 8, covr.end)], { type: kind === 14 ? 'image/png' : 'image/jpeg' });
      }
    }

    var chpl = find(dv, moov, ['udta', 'chpl']);
    var nero = chpl ? parseChpl(dv, chpl) : [];

    var tracks = boxes(dv, moov.start, moov.end).filter(function (b) { return b.type === 'trak'; }).map(function (b) { return trackInfo(dv, b); });
    var refs = [];
    tracks.forEach(function (t) { refs = refs.concat(t.chapRefs); });
    var chapTrack = tracks.filter(function (t) { return refs.indexOf(t.id) >= 0; })[0] ||
      tracks.filter(function (t) { return t.handler === 'text'; })[0];
    var qt = [];
    if (chapTrack) {
      try { qt = await readChapterTrack(file, dv, chapTrack); } catch (e) { qt = []; }
    }

    // The Nero list caps at 255 entries, so prefer whichever source has more.
    meta.chapters = qt.length >= nero.length ? qt : nero;
    return meta;
  }

  // ---------- MP3 / ID3v2 ----------

  function syncsafe(dv, o) {
    return (dv.getUint8(o) & 0x7f) << 21 | (dv.getUint8(o + 1) & 0x7f) << 14 | (dv.getUint8(o + 2) & 0x7f) << 7 | (dv.getUint8(o + 3) & 0x7f);
  }

  function id3Frames(dv, p, end, ver) {
    var out = [];
    while (p + 10 <= end) {
      var id = str(dv, p, 4);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      var size = ver === 4 ? syncsafe(dv, p + 4) : dv.getUint32(p + 4);
      out.push({ id: id, start: p + 10, end: Math.min(p + 10 + size, end) });
      p += 10 + size;
    }
    return out;
  }

  function id3Decode(arr, enc) {
    if (enc === 1) {
      if (arr[0] === 0xfe && arr[1] === 0xff) return decode(arr.subarray(2), 'utf-16be');
      if (arr[0] === 0xff && arr[1] === 0xfe) return decode(arr.subarray(2), 'utf-16le');
      return decode(arr, 'utf-16le');
    }
    return decode(arr, enc === 2 ? 'utf-16be' : enc === 3 ? 'utf-8' : 'latin1');
  }

  function id3Text(dv, f) {
    if (f.end <= f.start) return '';
    return id3Decode(bytes(dv, f.start + 1, f.end), dv.getUint8(f.start)).split('\0')[0].trim();
  }

  // End of a null-terminated string starting at p (terminator is 2 bytes for UTF-16).
  function nullEnd(dv, p, end, wide) {
    if (wide) {
      while (p + 1 < end && (dv.getUint8(p) || dv.getUint8(p + 1))) p += 2;
      return p + 2;
    }
    while (p < end && dv.getUint8(p)) p++;
    return p + 1;
  }

  async function parseMp3(file) {
    var h = await readBytes(file, 0, 10);
    if (h.byteLength < 10 || str(h, 0, 3) !== 'ID3') return null;
    var ver = h.getUint8(3), flags = h.getUint8(5), size = syncsafe(h, 6);
    if (ver < 3) return null;
    var dv = await readBytes(file, 10, size), p = 0;
    if (flags & 0x40) p = ver === 4 ? syncsafe(dv, 0) : dv.getUint32(0) + 4;

    var meta = { title: '', author: '', cover: null, chapters: [] };
    id3Frames(dv, p, dv.byteLength, ver).forEach(function (f) {
      if (f.id === 'TIT2') meta.title = id3Text(dv, f);
      else if (f.id === 'TALB' && !meta.title) meta.title = id3Text(dv, f);
      else if (f.id === 'TPE1' || (f.id === 'TPE2' && !meta.author)) meta.author = id3Text(dv, f);
      else if (f.id === 'APIC' && !meta.cover) {
        var enc = dv.getUint8(f.start), q = nullEnd(dv, f.start + 1, f.end, false);
        var mime = str(dv, f.start + 1, q - f.start - 2) || 'image/jpeg';
        q = nullEnd(dv, q + 1, f.end, enc === 1 || enc === 2);
        if (q < f.end) meta.cover = new Blob([bytes(dv, q, f.end)], { type: mime.indexOf('/') > 0 ? mime : 'image/' + mime.toLowerCase() });
      } else if (f.id === 'CHAP') {
        var c = nullEnd(dv, f.start, f.end, false);
        if (c + 16 > f.end) return;
        var chap = { start: dv.getUint32(c) / 1000, title: '' };
        id3Frames(dv, c + 16, f.end, ver).forEach(function (sub) {
          if (sub.id === 'TIT2') chap.title = id3Text(dv, sub);
        });
        meta.chapters.push(chap);
      }
    });
    meta.chapters.sort(function (a, b) { return a.start - b.start; });
    return meta;
  }

  async function read(file) {
    var meta = null;
    try {
      var head = await readBytes(file, 0, 12);
      if (head.byteLength >= 8 && str(head, 4, 4) === 'ftyp') meta = await parseMp4(file);
      else meta = await parseMp3(file);
    } catch (e) {
      console.warn('Could not read tags', e);
    }
    meta = meta || { title: '', author: '', cover: null, chapters: [] };
    if (!meta.title) meta.title = file.name.replace(/\.[^.]+$/, '');
    meta.chapters = meta.chapters.filter(function (c, i, all) { return i === 0 || c.start > all[i - 1].start; });
    meta.chapters.forEach(function (c, i) { if (!c.title) c.title = 'Chapter ' + (i + 1); });
    return meta;
  }

  return { read: read };
})();
