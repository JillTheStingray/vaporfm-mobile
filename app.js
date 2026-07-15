/* VaporFM Mobile PWA */
"use strict";

const STATIONS = {
  tv:       { name: "Vapor TV",   kind: "video", np: "https://radio.zelerk.com/api/nowplaying/vapor",
              src: "https://watch.vapor.fm/hls/stream.m3u8" },
  vapor:    { name: "Vapor Radio", kind: "audio", np: "https://radio.zelerk.com/api/nowplaying/vapor",
              src: "https://radio.zelerk.com/listen/vapor/stream.mp3" },
  chiptune: { name: "Chiptune",   kind: "audio", np: "https://radio.zelerk.com/api/nowplaying/chiptune",
              src: "https://radio.zelerk.com/listen/chiptune/stream.mp3" },
  keygen:   { name: "Keygen FM",  kind: "audio", np: "https://radio.zelerk.com/api/nowplaying/keygen",
              src: "https://radio.zelerk.com/listen/keygen/stream.mp3" },
};
const POLL_MS = 10000;
const HISTORY_CAP = 1000;

const $ = (id) => document.getElementById(id);
const video = $("video"), radio = $("radio");

let hls = null;
let current = localStorage.getItem("station") || "tv";
let view = "player";
let np = null;
let library = loadLibrary();
let libTab = "history";
let audioCtx = null, analyser = null, vizRaf = 0;
let bannerTimer = null, bannerHide = null;

/* ---------------- library (localStorage) ---------------- */
function loadLibrary() {
  try {
    const d = JSON.parse(localStorage.getItem("library"));
    if (d && Array.isArray(d.favorites) && Array.isArray(d.history)) return d;
  } catch (_) {}
  return { favorites: [], history: [] };
}
let saveTimer = null;
function saveLibrary() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem("library", JSON.stringify(library)); } catch (_) {}
  }, 300);
}
function addHistory(entry) {
  const recent = library.history.slice(0, 10);
  const dup = recent.some((h) =>
    h.artist === entry.artist && h.title === entry.title &&
    Date.parse(entry.playedAt) - Date.parse(h.playedAt) < 15 * 60 * 1000);
  if (dup) return;
  library.history.unshift(entry);
  if (library.history.length > HISTORY_CAP) library.history.length = HISTORY_CAP;
  saveLibrary();
}
function toggleFavorite(entry) {
  const key = (s) => `${s.artist} ${s.title}`;
  const idx = library.favorites.findIndex((f) => key(f) === key(entry));
  if (idx >= 0) library.favorites.splice(idx, 1);
  else library.favorites.unshift({ ...entry, savedAt: new Date().toISOString() });
  saveLibrary();
}
function isFaved(entry) {
  return library.favorites.some((f) => f.artist === entry.artist && f.title === entry.title);
}

/* ---------------- CRT ---------------- */
$("crtToggle").onclick = () => {
  $("crt").classList.toggle("hidden");
  $("crtToggle").classList.toggle("on");
};

/* ---------------- playback ---------------- */
function stopPlayback() {
  if (hls) { hls.destroy(); hls = null; }
  video.pause();
  video.removeAttribute("src");
  video.load();
  radio.pause();
  radio.removeAttribute("src");
  radio.load();
  cancelAnimationFrame(vizRaf);
}

function playStation(id) {
  const st = STATIONS[id];
  stopPlayback();
  current = id;
  localStorage.setItem("station", id);
  np = null;
  renderNowPlaying();

  document.querySelectorAll(".tab-item[data-station]").forEach((el) =>
    el.classList.toggle("active", el.dataset.station === id));

  const isVideo = st.kind === "video";
  video.classList.toggle("hidden", !isVideo);
  $("radioStage").classList.toggle("hidden", isVideo);
  $("quality").classList.toggle("hidden", !isVideo);

  let playPromise;
  if (isVideo) {
    if (Hls.isSupported()) {
      hls = new Hls({ liveSyncDurationCount: 3 });
      hls.loadSource(st.src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        fillQuality();
        video.play().catch(showTapHint);
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else if (data.type === Hls.ErrorTypes.NETWORK_ERROR)
          setTimeout(() => { if (hls && current === id) hls.startLoad(); }, 2000);
        else playStation(id);
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = st.src;
      playPromise = video.play();
    }
  } else {
    radio.src = st.src;
    playPromise = radio.play();
    if (playPromise) playPromise.then(startVisualizer).catch(showTapHint);
  }
  pollNowPlaying();
}

function showTapHint() {
  $("tapHint").classList.remove("hidden");
}
$("tapHint").onclick = () => {
  $("tapHint").classList.add("hidden");
  const el = STATIONS[current].kind === "video" ? video : radio;
  el.play().then(() => {
    if (STATIONS[current].kind === "audio") startVisualizer();
  }).catch(() => {});
};

function fillQuality() {
  const sel = $("quality");
  sel.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "-1"; auto.textContent = "AUTO";
  sel.appendChild(auto);
  hls.levels.forEach((lv, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = `${Math.round(lv.bitrate / 1e6)}Mbps`;
    sel.appendChild(o);
  });
  sel.onchange = () => { hls.currentLevel = parseInt(sel.value, 10); };
}

document.querySelectorAll(".tab-item[data-station]").forEach((el) => {
  el.onclick = () => { showView("player"); playStation(el.dataset.station); };
});
document.querySelector('.tab-item[data-view="library"]').onclick = () => showView("library");

function showView(v) {
  view = v;
  $("playerView").classList.toggle("hidden", v !== "player");
  $("libraryView").classList.toggle("hidden", v !== "library");
  document.querySelector('.tab-item[data-view="library"]')
    .classList.toggle("active", v === "library");
  if (v === "library") renderLibrary();
  if (v === "player")
    document.querySelectorAll(".tab-item[data-station]").forEach((el) =>
      el.classList.toggle("active", el.dataset.station === current));
}

/* ---------------- now playing ---------------- */
async function pollNowPlaying() {
  try {
    const res = await fetch(STATIONS[current].np, { cache: "no-store" });
    const data = await res.json();
    const s = data.now_playing.song;
    const fresh = {
      station: current,
      artist: (s.artist || "").trim(),
      title: (s.title || s.text || "").trim(),
      art: s.art || "",
      elapsed: data.now_playing.elapsed || 0,
      duration: data.now_playing.duration || 0,
      fetchedAt: Date.now(),
      offline: data.is_online === false,
    };
    $("liveChip").classList.toggle("on", !fresh.offline);
    const isFirst = !np;
    const changed = isFirst || np.title !== fresh.title || np.artist !== fresh.artist;
    np = fresh;
    if (changed && !fresh.offline) {
      addHistory({
        station: STATIONS[current].name, artist: np.artist, title: np.title,
        art: np.art, playedAt: new Date().toISOString(),
      });
      if (view === "library") renderLibrary();
      scheduleBanner(fresh, isFirst);
      updateMediaSession(fresh);
    }
    renderNowPlaying();
  } catch (_) { /* offline; next poll */ }
}
setInterval(pollNowPlaying, POLL_MS);

function renderNowPlaying() {
  if (!np) {
    $("npTitle").textContent = "…";
    $("npArtist").textContent = "";
    $("npArt").removeAttribute("src");
    $("npBar").style.width = "0%";
    $("npTime").textContent = "";
    $("favBtn").classList.remove("faved");
    return;
  }
  if (np.offline) {
    $("npTitle").textContent = "— station offline —";
    $("npArtist").textContent = "come back later";
    $("npBar").style.width = "0%";
    $("npTime").textContent = "";
    $("favBtn").classList.remove("faved");
    return;
  }
  $("npTitle").textContent = np.title || "…";
  $("npArtist").textContent = np.artist;
  if (np.art) { $("npArt").src = np.art; $("radioArt").src = np.art; }
  $("favBtn").classList.toggle("faved", isFaved(np));
  tickProgress();
}

function fmt(sec) {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}
function tickProgress() {
  if (!np || !np.duration || np.offline) { $("npBar").style.width = "0%"; $("npTime").textContent = ""; return; }
  const elapsed = Math.min(np.duration, np.elapsed + (Date.now() - np.fetchedAt) / 1000);
  $("npBar").style.width = `${(elapsed / np.duration) * 100}%`;
  $("npTime").textContent = `${fmt(elapsed)} / ${fmt(np.duration)}`;
}
setInterval(tickProgress, 1000);

/* ---------------- media session (lock screen) ---------------- */
function updateMediaSession(song) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title || "VaporFM",
    artist: song.artist || STATIONS[current].name,
    album: STATIONS[current].name,
    artwork: song.art ? [
      { src: song.art, sizes: "512x512", type: "image/jpeg" },
    ] : [{ src: "icons/icon-512.png", sizes: "512x512", type: "image/png" }],
  });
  const el = () => (STATIONS[current].kind === "video" ? video : radio);
  navigator.mediaSession.setActionHandler("play", () => el().play());
  navigator.mediaSession.setActionHandler("pause", () => el().pause());
  navigator.mediaSession.setActionHandler("stop", () => el().pause());
}

/* ---------------- banner ---------------- */
function scheduleBanner(song, immediate = false) {
  const delay = immediate ? 1200 : song.station === "tv" ? 13000 : 2000;
  const key = `${song.artist}|${song.title}`;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => {
    if (!np || `${np.artist}|${np.title}` !== key || np.offline) return;
    const bn = $("banner");
    bn.classList.remove("show");
    void bn.offsetWidth; // restart CSS animation
    $("bnTitle").textContent = np.title;
    $("bnArtist").textContent = np.artist;
    if (np.art) { $("bnArt").src = np.art; $("bnArt").style.display = ""; }
    else $("bnArt").style.display = "none";
    bn.classList.remove("hidden");
    bn.classList.add("show");
    clearTimeout(bannerHide);
    bannerHide = setTimeout(() => bn.classList.add("hidden"), 6300);
  }, delay);
}

/* ---------------- favorites / actions ---------------- */
$("favBtn").onclick = () => {
  if (!np || !np.title || np.offline) return;
  toggleFavorite({ station: STATIONS[current].name, artist: np.artist, title: np.title, art: np.art });
  renderNowPlaying();
};
$("ytBtn").onclick = () => {
  if (np && np.title)
    window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(`${np.artist} ${np.title}`)}`);
};

/* ---------------- visualizer ---------------- */
function startVisualizer() {
  const canvas = $("visualizer");
  const ctx2d = canvas.getContext("2d");
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const srcNode = audioCtx.createMediaElementSource(radio);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      srcNode.connect(analyser);
      analyser.connect(audioCtx.destination);
    }
    audioCtx.resume();
  } catch (_) { return; } // tainted or unsupported: skip visualizer, audio still plays
  const bins = new Uint8Array(analyser.frequencyBinCount);

  function draw() {
    vizRaf = requestAnimationFrame(draw);
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    analyser.getByteFrequencyData(bins);
    const n = 36, bw = canvas.width / n;
    for (let i = 0; i < n; i++) {
      const v = bins[Math.floor((i / n) * bins.length)] / 255;
      const h = v * canvas.height * 0.92;
      const grad = ctx2d.createLinearGradient(0, canvas.height - h, 0, canvas.height);
      grad.addColorStop(0, "#01cdfe");
      grad.addColorStop(1, "#ff71ce");
      ctx2d.fillStyle = grad;
      ctx2d.fillRect(i * bw + 2, canvas.height - h, bw - 4, h);
    }
  }
  cancelAnimationFrame(vizRaf);
  draw();
}

/* ---------------- library view ---------------- */
document.querySelectorAll(".tab").forEach((t) => {
  t.onclick = () => {
    libTab = t.dataset.tab;
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    renderLibrary();
  };
});
$("libSearch").oninput = () => renderLibrary();

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function toCsv(rows) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return ["station,artist,title,playedAt",
    ...rows.map((r) => [r.station, r.artist, r.title, r.playedAt || r.savedAt].map(esc).join(","))].join("\r\n");
}
$("exportJson").onclick = () =>
  download(`vaporfm-${libTab}.json`, JSON.stringify(library[libTab], null, 1), "application/json");
$("exportCsv").onclick = () =>
  download(`vaporfm-${libTab}.csv`, toCsv(library[libTab]), "text/csv");

function renderLibrary() {
  const q = $("libSearch").value.trim().toLowerCase();
  const rows = library[libTab] || [];
  const list = $("libList");
  list.innerHTML = "";

  const filtered = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !q || `${r.artist} ${r.title}`.toLowerCase().includes(q));

  if (!filtered.length) {
    list.innerHTML = `<div class="lib-empty">— ${q ? "no matches" : "empty"} —</div>`;
    return;
  }

  for (const { r, i } of filtered) {
    const row = document.createElement("div");
    row.className = "lib-row";

    const img = document.createElement("img");
    if (r.art) img.src = r.art;
    row.appendChild(img);

    const meta = document.createElement("div");
    meta.className = "lib-meta";
    const t = document.createElement("div");
    t.className = "lib-title";
    t.textContent = r.title || "(untitled)";
    const sub = document.createElement("div");
    sub.className = "lib-sub";
    const when = new Date(r.playedAt || r.savedAt || Date.now());
    sub.textContent = `${r.artist} · ${r.station || ""} · ${when.toLocaleString()}`;
    meta.append(t, sub);
    row.appendChild(meta);

    const yt = document.createElement("button");
    yt.className = "rowbtn"; yt.textContent = "YT";
    yt.onclick = () =>
      window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(`${r.artist} ${r.title}`)}`);
    row.appendChild(yt);

    const heart = document.createElement("button");
    heart.className = "heart" + (isFaved(r) ? " faved" : "");
    heart.textContent = "♥";
    heart.onclick = () => {
      toggleFavorite({ station: r.station, artist: r.artist, title: r.title, art: r.art });
      renderLibrary(); renderNowPlaying();
    };
    row.appendChild(heart);

    const del = document.createElement("button");
    del.className = "rowbtn"; del.textContent = "✕";
    del.onclick = () => {
      library[libTab].splice(i, 1);
      saveLibrary();
      renderLibrary();
    };
    row.appendChild(del);

    list.appendChild(row);
  }
}

/* ---------------- boot ---------------- */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
playStation(current);
