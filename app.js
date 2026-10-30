// Audiobook player. Written in ES2017 (no optional chaining etc.) so it runs
// on the Chrome versions available for Android 7.

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var audio = $('audio');
  var SKIP = 30;

  // ---------- IndexedDB ----------
  // books:    book metadata (title, chapters, cover...) keyed by id
  // files:    the audio file itself, only when the user chose to keep a copy
  // progress: position, speed and bookmarks per book

  var dbPromise = new Promise(function (resolve, reject) {
    var req = indexedDB.open('audiobooks', 1);
    req.onupgradeneeded = function () {
      var db = req.result;
      db.createObjectStore('books', { keyPath: 'id' });
      db.createObjectStore('files');
      db.createObjectStore('progress', { keyPath: 'id' });
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });

  function tx(store, mode, fn) {
    return dbPromise.then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, mode), result;
        var r = fn(t.objectStore(store));
        r.onsuccess = function () { result = r.result; };
        t.oncomplete = function () { resolve(result); };
        t.onerror = t.onabort = function () { reject(t.error); };
      });
    });
  }
  function dbGet(store, key) { return tx(store, 'readonly', function (s) { return s.get(key); }); }
  function dbAll(store) { return tx(store, 'readonly', function (s) { return s.getAll(); }); }
  function dbPut(store, value, key) {
    return tx(store, 'readwrite', function (s) { return key === undefined ? s.put(value) : s.put(value, key); });
  }
  function dbDel(store, key) { return tx(store, 'readwrite', function (s) { return s.delete(key); }); }

  // ---------- State ----------

  var books = [];
  var progress = {};      // id -> { id, pos, rate, bookmarks, updated, finished }
  var sessionFiles = {};  // id -> File picked this session (for books without a saved copy)
  var coverUrls = {};
  var current = null;
  var objectUrl = null;
  var pendingSeek = null;
  var pausedAt = 0;
  var lastSave = 0;
  var lastPosState = 0;
  var shownChapter = -2;
  var sleep = null;       // { until: ms timestamp } or { chapter: index }
  var dragging = null;    // { start, end } while the seek slider is held

  function getProgress(id) {
    if (!progress[id]) progress[id] = { id: id, pos: 0, rate: 1, bookmarks: [], updated: 0 };
    return progress[id];
  }

  // ---------- Formatting ----------

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function clock(s) {
    s = Math.max(0, Math.floor(s || 0));
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return (h ? h + ':' + pad(m) : m) + ':' + pad(x);
  }
  function human(s) {
    var mins = Math.max(0, Math.round((s || 0) / 60)), h = Math.floor(mins / 60), m = mins % 60;
    if (!mins && s > 0) return '<1m';
    return h ? h + 'h ' + m + 'm' : m + 'm';
  }
  function rateText(r) {
    var s = String(Math.round(r * 100) / 100);
    return (s.indexOf('.') < 0 ? s + '.0' : s) + '×';
  }
  function gb(bytes) {
    return bytes >= 1e9 ? (bytes / 1e9).toFixed(1) + ' GB' : Math.round(bytes / 1e6) + ' MB';
  }

  var toastTimer;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, ms || 2500);
  }

  // ---------- Back button / layers ----------
  // The player and sheets push a history entry so Android's back button closes them.

  var layers = [], popWaiters = [], settled = Promise.resolve();
  // Runs fn once any pending history.back() has been handled, so a new layer
  // isn't closed by the popstate meant for the previous one.
  function afterBack(fn) {
    if (popWaiters.length) settled.then(fn);
    else fn();
  }
  function pushLayer(close) {
    layers.push(close);
    history.pushState({ layer: layers.length }, '');
  }
  function back() {
    settled = new Promise(function (resolve) {
      popWaiters.push(resolve);
      history.back();
    });
    return settled;
  }
  window.addEventListener('popstate', function () {
    var close = layers.pop();
    if (close) close();
    var w = popWaiters.shift();
    if (w) w();
  });

  // ---------- Covers ----------

  function coverUrl(book) {
    if (!book.cover) return null;
    if (!coverUrls[book.id]) coverUrls[book.id] = URL.createObjectURL(book.cover);
    return coverUrls[book.id];
  }
  function paintCover(el, book) {
    var url = book && coverUrl(book);
    el.style.backgroundImage = url ? 'url("' + url + '")' : '';
    el.textContent = url || !book ? '' : book.title.split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase();
  }

  // ---------- Library ----------

  function bookDuration(b) {
    return current && current.id === b.id && isFinite(audio.duration) ? audio.duration : b.duration || 0;
  }

  function renderLibrary() {
    var list = $('books');
    list.innerHTML = '';
    $('empty').classList.toggle('hidden', books.length > 0);
    books.slice().sort(function (a, b) {
      return (getProgress(b.id).updated || b.added) - (getProgress(a.id).updated || a.added);
    }).forEach(function (b) {
      var p = getProgress(b.id), d = bookDuration(b);
      var el = document.createElement('div');
      el.className = 'book' + (current && current.id === b.id ? ' current' : '');
      el.innerHTML = '<div class="thumb"></div><div class="info"><div class="title"></div><div class="author"></div>' +
        '<div class="sub"></div><div class="bar"><div></div></div></div>' +
        '<button class="more" aria-label="Options"><svg><use href="#i-more"/></svg></button>';
      paintCover(el.querySelector('.thumb'), b);
      el.querySelector('.title').textContent = b.title;
      el.querySelector('.author').textContent = b.author || '';
      var sub;
      if (p.finished) sub = 'Finished';
      else if (p.pos > 0 && d) sub = human(d - p.pos) + ' left';
      else sub = d ? human(d) : 'Not started';
      if (!b.stored && !sessionFiles[b.id]) sub += ' · tap to re-select file';
      el.querySelector('.sub').textContent = sub;
      el.querySelector('.bar div').style.width = (p.finished ? 100 : d ? Math.min(100, p.pos / d * 100) : 0) + '%';
      el.addEventListener('click', function () { openBook(b, true, true); });
      el.querySelector('.more').addEventListener('click', function (e) { e.stopPropagation(); bookMenu(b); });
      list.appendChild(el);
    });
    showStorage();
  }

  function showStorage() {
    if (!navigator.storage || !navigator.storage.estimate) return;
    navigator.storage.estimate().then(function (e) {
      $('storage').textContent = 'Saved books use ' + gb(e.usage) + ' · about ' + gb(Math.max(0, e.quota - e.usage)) + ' available';
    });
  }

  function pickFile() {
    return new Promise(function (resolve) {
      var input = $('filePick');
      input.value = '';
      input.onchange = function () { resolve(input.files[0] || null); };
      input.click();
    });
  }

  $('addBtn').addEventListener('click', function () { pickFile().then(importFile); });

  async function importFile(file) {
    if (!file) return;
    var id = file.name + '|' + file.size;
    var existing = books.filter(function (b) { return b.id === id; })[0];
    if (existing) {
      sessionFiles[id] = file;
      toast('Already in your library');
      openBook(existing, true, true);
      return;
    }

    toast('Reading ' + file.name + '…', 10000);
    var meta = await BookMeta.read(file);
    var keep = await askKeepCopy(file, meta);
    if (keep === null) return;

    var book = {
      id: id, name: file.name, size: file.size, title: meta.title, author: meta.author,
      cover: meta.cover, chapters: meta.chapters, duration: 0, added: Date.now(), stored: false
    };
    if (keep) {
      toast('Saving a copy… (large books can take a minute)', 120000);
      try {
        await dbPut('files', file, id);
        book.stored = true;
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
      } catch (e) {
        console.warn(e);
        toast('Not enough space to save a copy. It will play from the original file.', 5000);
      }
    }
    sessionFiles[id] = file;
    await dbPut('books', book);
    books.push(book);
    toast(book.chapters.length ? 'Added · ' + book.chapters.length + ' chapters' : 'Added');
    renderLibrary();
    openBook(book, true, true);
  }

  function askKeepCopy(file, meta) {
    return new Promise(function (resolve) {
      var answered = false;
      function answer(v) {
        if (answered) return;
        answered = true;
        back().then(function () { resolve(v); });
      }
      openSheet(meta.title, function (body) {
        var info = document.createElement('p');
        info.style.cssText = 'margin:0;padding:0 20px 8px;color:var(--muted);font-size:14px';
        info.textContent = gb(file.size) + (meta.chapters.length ? ' · ' + meta.chapters.length + ' chapters' : ' · no chapters found');
        body.appendChild(info);
        var label = document.createElement('div');
        label.className = 'check';
        label.innerHTML = '<div><b>Save a copy in the app?</b><small>Recommended. The book stays available offline and you never have to pick the file again. ' +
          'Uses ' + gb(file.size) + ' of extra space. If you skip this, you re-select the file each time you open the app.</small></div>';
        body.appendChild(label);
        var actions = document.createElement('div');
        actions.className = 'actions';
        actions.innerHTML = '<button data-v="0">Just play it</button><button class="primary" data-v="1">Save copy</button>';
        actions.addEventListener('click', function (e) {
          var v = e.target.getAttribute('data-v');
          if (v !== null) answer(v === '1');
        });
        body.appendChild(actions);
      }, function () { if (!answered) { answered = true; resolve(null); } });
    });
  }

  function bookMenu(b) {
    openSheet(b.title, function (body) {
      body.appendChild(item('', 'Start over', '', function () {
        back().then(function () {
          var p = getProgress(b.id);
          p.pos = 0; p.finished = false; p.updated = Date.now();
          dbPut('progress', p);
          if (current && current.id === b.id) seekTo(0);
          renderLibrary();
        });
      }));
      body.appendChild(item('', 'Remove from library', '', function () {
        back().then(function () {
          if (confirm('Remove "' + b.title + '"? Your saved copy and progress will be deleted.')) removeBook(b);
        });
      }, 'danger'));
    });
  }

  async function removeBook(b) {
    if (current && current.id === b.id) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      current = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      localStorage.removeItem('lastBook');
      $('mini').classList.add('hidden');
    }
    await dbDel('books', b.id);
    await dbDel('files', b.id);
    await dbDel('progress', b.id);
    delete progress[b.id];
    delete sessionFiles[b.id];
    books = books.filter(function (x) { return x.id !== b.id; });
    renderLibrary();
  }

  // ---------- Loading a book ----------

  async function openBook(book, play, show) {
    if (current && current.id === book.id && audio.src) {
      if (show) showPlayer();
      if (play && audio.paused) resume();
      return;
    }
    var file = sessionFiles[book.id] || (book.stored ? await dbGet('files', book.id) : null);
    if (!file) {
      if (!show) return;
      toast('Select "' + book.name + '" to continue', 4000);
      file = await pickFile();
      if (!file) return;
      if (file.size !== book.size && !confirm('That doesn\'t look like the same file. Use it anyway?')) return;
      sessionFiles[book.id] = file;
    }

    saveProgress();
    current = book;
    shownChapter = -2;
    localStorage.setItem('lastBook', book.id);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);

    var p = getProgress(book.id);
    pendingSeek = p.finished ? 0 : p.pos || 0;
    pausedAt = 0;
    audio.src = objectUrl;
    audio.defaultPlaybackRate = audio.playbackRate = p.rate || 1;
    audio.load();

    paintPlayer();
    renderLibrary();
    if (show) showPlayer();
    if (play) resume();
  }

  audio.addEventListener('loadedmetadata', function () {
    if (!current) return;
    if (pendingSeek !== null) {
      audio.currentTime = Math.min(pendingSeek, Math.max(0, audio.duration - 1));
      pendingSeek = null;
    }
    if (current && Math.abs((current.duration || 0) - audio.duration) > 1) {
      current.duration = audio.duration;
      dbPut('books', current);
    }
    audio.playbackRate = getProgress(current.id).rate || 1;
    tick();
  });

  audio.addEventListener('error', function () {
    if (current) toast('This file can\'t be played on this device.', 5000);
  });

  // ---------- Playback ----------

  function resume() {
    if (!current) return;
    // After a long pause, rewind a little so you can pick up the thread again.
    if (pausedAt && Date.now() - pausedAt > 60000 && pendingSeek === null) audio.currentTime = Math.max(0, audio.currentTime - 5);
    pausedAt = 0;
    var r = audio.play();
    if (r && r.catch) r.catch(function (e) { console.warn(e); });
  }
  function togglePlay() { if (audio.paused) resume(); else audio.pause(); }

  function duration() { return isFinite(audio.duration) ? audio.duration : current ? current.duration || 0 : 0; }
  function now() { return pendingSeek !== null ? pendingSeek : audio.currentTime; }

  function seekTo(t) {
    if (!current) return;
    t = Math.max(0, Math.min(t, duration() || t));
    pausedAt = 0;
    if (pendingSeek !== null) pendingSeek = t;
    else audio.currentTime = t;
    tick();
    saveProgress();
  }
  function seekBy(s) { seekTo(now() + s); }

  function chapters() { return current ? current.chapters : []; }
  function chapterAt(t) {
    var c = chapters(), i = c.length - 1;
    while (i > 0 && c[i].start > t + 0.25) i--;
    return i;
  }
  function chapterRange(i) {
    var c = chapters();
    if (i < 0) return { start: 0, end: duration() };
    return { start: c[i].start, end: i + 1 < c.length ? c[i + 1].start : duration() };
  }
  function prevChapter() {
    var i = chapterAt(now());
    if (i < 0) return seekBy(-SKIP);
    var start = chapters()[i].start;
    seekTo(now() - start > 3 || i === 0 ? start : chapters()[i - 1].start);
  }
  function nextChapter() {
    var i = chapterAt(now());
    if (i < 0) return seekBy(SKIP);
    if (i + 1 < chapters().length) seekTo(chapters()[i + 1].start);
  }

  function setRate(r) {
    r = Math.max(0.5, Math.min(4, Math.round(r * 100) / 100));
    audio.defaultPlaybackRate = audio.playbackRate = r;
    if (current) {
      var p = getProgress(current.id);
      p.rate = r;
      dbPut('progress', p);
    }
    $('speedLabel').textContent = rateText(r);
    $('bSpeed').classList.toggle('on', r !== 1);
    lastPosState = 0;
    tick();
  }

  function saveProgress() {
    if (!current || pendingSeek !== null || audio.readyState === 0) return;
    var p = getProgress(current.id);
    p.pos = audio.currentTime;
    p.updated = Date.now();
    if (p.finished && audio.currentTime < duration() - 5) p.finished = false;
    lastSave = Date.now();
    dbPut('progress', p);
  }

  audio.addEventListener('timeupdate', function () {
    tick();
    if (!audio.paused && Date.now() - lastSave > 5000) saveProgress();
  });
  audio.addEventListener('play', paintPlayState);
  audio.addEventListener('pause', function () {
    pausedAt = Date.now();
    paintPlayState();
    saveProgress();
  });
  audio.addEventListener('ended', function () {
    if (!current) return;
    var p = getProgress(current.id);
    p.finished = true;
    p.pos = duration();
    p.updated = Date.now();
    dbPut('progress', p);
    clearSleep();
    paintPlayState();
  });
  audio.addEventListener('seeked', saveProgress);
  document.addEventListener('visibilitychange', function () { if (document.hidden) saveProgress(); });
  window.addEventListener('pagehide', saveProgress);

  // ---------- Sleep timer ----------

  function setSleep(s) {
    sleep = s;
    audio.volume = 1;
    tick();
  }
  function clearSleep() { setSleep(null); }

  function checkSleep(t) {
    if (!sleep) return;
    if (sleep.chapter !== undefined) {
      if (chapterAt(t) > sleep.chapter) {
        audio.pause();
        clearSleep();
      }
      return;
    }
    var left = (sleep.until - Date.now()) / 1000;
    if (left <= 0) {
      audio.pause();
      clearSleep();
    } else if (left < 10 && !audio.paused) {
      audio.volume = Math.max(0.05, left / 10);  // fade out over the last 10 seconds
    }
  }

  // Keeps the countdown moving while paused or when timeupdate is sparse.
  setInterval(function () { if (sleep) tick(); }, 1000);

  // ---------- Player UI ----------

  function showPlayer() {
    if (popWaiters.length) return afterBack(showPlayer);
    if (!$('player').classList.contains('hidden')) return;
    $('player').classList.remove('hidden');
    pushLayer(function () { $('player').classList.add('hidden'); renderLibrary(); });
  }

  function paintPlayer() {
    if (!current) return;
    $('pBook').textContent = current.title;
    paintCover($('pCover'), current);
    paintCover($('miniThumb'), current);
    $('mini').classList.remove('hidden');
    var noChapters = !chapters().length;
    $('bPrev').style.opacity = $('bNext').style.opacity = noChapters ? 0.3 : 1;
    setRate(getProgress(current.id).rate || 1);
    paintPlayState();
  }

  function paintPlayState() {
    var playing = !audio.paused;
    var icon = playing ? '#i-pause' : '#i-play';
    $('bPlay').innerHTML = '<svg><use href="' + icon + '"/></svg>';
    $('miniPlay').innerHTML = '<svg><use href="' + icon + '"/></svg>';
    $('bPlay').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if (ms) ms.playbackState = playing ? 'playing' : 'paused';
  }

  function tick() {
    if (!current) return;
    var t = now(), d = duration(), i = chapterAt(t), c = chapters();
    checkSleep(t);

    if (i !== shownChapter) {
      shownChapter = i;
      $('pChap').textContent = i >= 0 ? c[i].title : current.title;
      $('pMeta').textContent = [i >= 0 ? 'Chapter ' + (i + 1) + ' of ' + c.length : '', current.author].filter(Boolean).join(' · ');
      $('miniTitle').textContent = current.title;
      updateMediaMetadata();
    }

    var r = dragging || chapterRange(i), span = Math.max(1, r.end - r.start);
    var shown = dragging ? r.start + $('seek').value / 1000 * span : t;
    if (!dragging) $('seek').value = Math.round((t - r.start) / span * 1000);
    $('seek').style.setProperty('--fill', ($('seek').value / 10) + '%');
    $('tLeft').textContent = clock(shown - r.start);
    $('tRight').textContent = '-' + clock(r.end - shown);

    var rate = audio.playbackRate || 1;
    $('tTotal').textContent = d ? human((d - t) / rate) + ' left' + (rate !== 1 ? ' at ' + rateText(rate) : '') +
      (c.length ? ' · ' + Math.floor(t / d * 100) + '%' : '') : '';
    $('totalBar').style.width = (d ? t / d * 100 : 0) + '%';
    $('totalWrap').querySelector('.bar').classList.toggle('hidden', !c.length);
    $('miniSub').textContent = (i >= 0 ? c[i].title + ' · ' : '') + (d ? human((d - t) / rate) + ' left' : '');

    var label = 'Sleep';
    if (sleep) label = sleep.chapter !== undefined ? 'End of ch.' : clock((sleep.until - Date.now()) / 1000);
    $('sleepLabel').textContent = label;
    $('bSleep').classList.toggle('on', !!sleep);

    if (ms && ms.setPositionState && d && Date.now() - lastPosState > 5000) {
      lastPosState = Date.now();
      try { ms.setPositionState({ duration: d, playbackRate: rate, position: Math.min(t, d) }); } catch (e) { /* older Chrome */ }
    }
  }

  var seek = $('seek');
  seek.addEventListener('input', function () {
    if (!dragging) dragging = chapterRange(chapterAt(now()));
    tick();
  });
  seek.addEventListener('change', function () {
    var r = dragging || chapterRange(chapterAt(now()));
    dragging = null;
    seekTo(r.start + seek.value / 1000 * (r.end - r.start));
  });

  $('bPlay').addEventListener('click', togglePlay);
  $('bBack').addEventListener('click', function () { seekBy(-SKIP); });
  $('bFwd').addEventListener('click', function () { seekBy(SKIP); });
  $('bPrev').addEventListener('click', prevChapter);
  $('bNext').addEventListener('click', nextChapter);
  $('closePlayer').addEventListener('click', function () { back(); });
  $('miniInfo').addEventListener('click', showPlayer);
  $('miniThumb').addEventListener('click', showPlayer);
  $('miniPlay').addEventListener('click', togglePlay);
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') seekBy(-SKIP);
    else if (e.key === 'ArrowRight') seekBy(SKIP);
  });

  // ---------- Sheets ----------

  function openSheet(title, build, onClose) {
    if (popWaiters.length) return afterBack(function () { openSheet(title, build, onClose); });
    var sheet = $('sheet');
    sheet.innerHTML = '';
    var h = document.createElement('h2');
    h.textContent = title;
    sheet.appendChild(h);
    var body = document.createElement('div');
    body.className = 'list';
    sheet.appendChild(body);
    build(body);
    sheet.classList.remove('hidden');
    $('scrim').classList.remove('hidden');
    pushLayer(function () {
      sheet.classList.add('hidden');
      $('scrim').classList.add('hidden');
      if (onClose) onClose();
    });
  }
  $('scrim').addEventListener('click', function () { back(); });

  function item(n, label, right, onClick, cls) {
    var b = document.createElement('button');
    b.className = 'item' + (cls ? ' ' + cls : '');
    b.innerHTML = (n !== '' ? '<span class="n"></span>' : '') + '<span class="l"></span><span class="r"></span>';
    if (n !== '') b.querySelector('.n').textContent = n;
    b.querySelector('.l').textContent = label;
    b.querySelector('.r').textContent = right || '';
    b.addEventListener('click', onClick);
    return b;
  }

  $('bChapters').addEventListener('click', function () {
    if (!current) return;
    var c = chapters(), active = chapterAt(now());
    openSheet('Chapters', function (body) {
      if (!c.length) {
        var p = document.createElement('p');
        p.style.cssText = 'padding:0 12px;color:var(--muted)';
        p.textContent = 'This file has no chapter markers.';
        body.appendChild(p);
      }
      c.forEach(function (ch, i) {
        var r = chapterRange(i);
        var el = item(i + 1, ch.title, clock(r.end - r.start), function () { seekTo(ch.start); back(); }, i === active ? 'active' : '');
        body.appendChild(el);
        if (i === active) setTimeout(function () { body.scrollTop = Math.max(0, el.offsetTop - body.clientHeight / 2); }, 0);
      });
    });
  });

  $('bSpeed').addEventListener('click', function () {
    openSheet('Playback speed', function (body) {
      var fine = document.createElement('div');
      fine.className = 'speed-fine';
      fine.innerHTML = '<button data-d="-0.05" aria-label="Slower">−</button><output></output><button data-d="0.05" aria-label="Faster">+</button>';
      var out = fine.querySelector('output');
      var chips = document.createElement('div');
      chips.className = 'chips';
      function paint() {
        out.textContent = rateText(audio.playbackRate);
        Array.prototype.forEach.call(chips.children, function (ch) {
          ch.classList.toggle('on', Math.abs(+ch.getAttribute('data-r') - audio.playbackRate) < 0.001);
        });
      }
      fine.addEventListener('click', function (e) {
        var d = e.target.getAttribute('data-d');
        if (d) { setRate(audio.playbackRate + +d); paint(); }
      });
      [0.75, 1, 1.1, 1.2, 1.25, 1.3, 1.4, 1.5, 1.75, 2, 2.5, 3].forEach(function (r) {
        var b = document.createElement('button');
        b.className = 'chip';
        b.setAttribute('data-r', r);
        b.textContent = rateText(r);
        b.addEventListener('click', function () { setRate(r); paint(); });
        chips.appendChild(b);
      });
      body.appendChild(fine);
      body.appendChild(chips);
      paint();
    });
  });

  $('bSleep').addEventListener('click', function () {
    openSheet('Sleep timer', function (body) {
      var chips = document.createElement('div');
      chips.className = 'chips';
      function add(label, on, fn) {
        var b = document.createElement('button');
        b.className = 'chip' + (on ? ' on' : '');
        b.textContent = label;
        b.addEventListener('click', function () { fn(); back(); });
        chips.appendChild(b);
      }
      add('Off', !sleep, clearSleep);
      [5, 10, 15, 20, 30, 45, 60, 90].forEach(function (m) {
        add(m + ' min', false, function () {
          setSleep({ until: Date.now() + m * 60000 });
          if (audio.paused) resume();
        });
      });
      if (chapters().length) {
        add('End of chapter', sleep && sleep.chapter !== undefined, function () {
          setSleep({ chapter: chapterAt(now()) });
          if (audio.paused) resume();
        });
      }
      body.appendChild(chips);
    });
  });

  $('bMark').addEventListener('click', function () {
    if (!current) return;
    var p = getProgress(current.id);
    if (!p.bookmarks) p.bookmarks = [];
    openSheet('Bookmarks', function (body) {
      function render() {
        body.innerHTML = '';
        body.appendChild(item('', '+ Add bookmark at ' + clock(now()), '', function () {
          var t = now(), i = chapterAt(t);
          p.bookmarks.push({ t: t, label: i >= 0 ? chapters()[i].title : current.title, added: Date.now() });
          p.bookmarks.sort(function (a, b) { return a.t - b.t; });
          dbPut('progress', p);
          toast('Bookmarked ' + clock(t));
          render();
        }));
        p.bookmarks.forEach(function (bm, idx) {
          var el = item('', bm.label, clock(bm.t), function () { seekTo(bm.t); back(); });
          var del = document.createElement('span');
          del.textContent = '✕';
          del.setAttribute('role', 'button');
          del.setAttribute('aria-label', 'Delete bookmark');
          del.style.cssText = 'padding:0 4px 0 14px;color:var(--muted)';
          del.addEventListener('click', function (e) {
            e.stopPropagation();
            p.bookmarks.splice(idx, 1);
            dbPut('progress', p);
            render();
          });
          el.appendChild(del);
          body.appendChild(el);
        });
      }
      render();
    });
  });

  // ---------- Lock screen / notification controls ----------

  var ms = 'mediaSession' in navigator ? navigator.mediaSession : null;
  if (ms) {
    var handlers = {
      play: resume,
      pause: function () { audio.pause(); },
      seekbackward: function () { seekBy(-SKIP); },
      seekforward: function () { seekBy(SKIP); },
      previoustrack: prevChapter,
      nexttrack: nextChapter,
      seekto: function (d) { seekTo(d.seekTime); }
    };
    Object.keys(handlers).forEach(function (k) {
      try { ms.setActionHandler(k, handlers[k]); } catch (e) { /* not supported on this version */ }
    });
  }

  function updateMediaMetadata() {
    if (!ms || !current || typeof MediaMetadata === 'undefined') return;
    var i = chapterAt(now()), url = coverUrl(current);
    ms.metadata = new MediaMetadata({
      title: i >= 0 ? chapters()[i].title : current.title,
      artist: current.author || '',
      album: current.title,
      artwork: url ? [{ src: url, sizes: '512x512', type: current.cover.type }] : [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }]
    });
  }

  // ---------- Start up ----------

  Promise.all([dbAll('books'), dbAll('progress')]).then(function (res) {
    books = res[0];
    res[1].forEach(function (p) { progress[p.id] = p; });
    renderLibrary();
    var last = localStorage.getItem('lastBook');
    var book = books.filter(function (b) { return b.id === last; })[0];
    if (book && book.stored) openBook(book, false, false);
  }).catch(function (e) {
    console.error(e);
    toast('Could not open storage: ' + e.message, 8000);
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('Service worker failed', e); });
  }
})();
