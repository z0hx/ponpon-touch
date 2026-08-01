(() => {
  "use strict";

  // ---- palettes -----------------------------------------------------
  const ACCENT = ["#FF6F91", "#FFC93C", "#4FC1E9", "#4CD787", "#A78BFA", "#FF9F45"];
  const BG     = ["#CFF5D9", "#FFF3C4", "#CFEFFB", "#FFE1EA", "#E6DFFF", "#FFE3C2"];

  const BLOB_PATHS = [
    "M52,8 C74,6 92,26 90,50 C88,74 70,92 48,90 C26,88 8,70 10,46 C12,22 30,10 52,8 Z",
    "M48,10 C68,4 92,20 88,46 C92,70 72,92 48,88 C24,92 6,72 10,48 C6,24 28,16 48,10 Z",
    "M50,6 C72,10 94,28 88,52 C84,76 62,94 40,88 C18,82 4,62 12,40 C20,18 30,4 50,6 Z",
  ];

  // pentatonic-ish scale across ~2 octaves (always sounds pleasant together)
  const NOTES = [261.6, 293.7, 329.6, 392.0, 440.0, 523.3, 587.3, 659.3, 784.0, 880.0];

  // ---- state ----------------------------------------------------------
  const stage = document.getElementById("stage");
  const startHint = document.getElementById("startHint");
  const installHint = document.getElementById("installHint");
  const parentCorner = document.getElementById("parentCorner");
  const settingsPanel = document.getElementById("settingsPanel");
  const soundToggle = document.getElementById("soundToggle");
  const bgToggle = document.getElementById("bgToggle");
  const backGuardToggle = document.getElementById("backGuardToggle");

  let prefs = { sound: true, bgCycle: true, backGuard: true, installDismissed: false };
  try {
    const saved = JSON.parse(localStorage.getItem("ponpon-prefs") || "{}");
    prefs = Object.assign(prefs, saved);
  } catch (e) { /* localStorage unavailable — fall back to in-memory defaults */ }

  function savePrefs() {
    try { localStorage.setItem("ponpon-prefs", JSON.stringify(prefs)); } catch (e) {}
  }

  soundToggle.checked = prefs.sound;
  bgToggle.checked = prefs.bgCycle;
  backGuardToggle.checked = prefs.backGuard;

  let bgIndex = 0;
  let touchCount = 0;
  let firstTouchDone = false;
  const activeBlobCount = { n: 0 };
  const MAX_BLOBS = 18;

  stage.style.backgroundColor = BG[bgIndex];

  // ---- audio ------------------------------------------------------------
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function playTone(freqIndex) {
    if (!prefs.sound) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    const freq = NOTES[Math.max(0, Math.min(NOTES.length - 1, freqIndex))];
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = freq;
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.52);
  }

  // ---- visuals ------------------------------------------------------------
  function spawnRipple(x, y) {
    const el = document.createElement("div");
    el.className = "ripple";
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.style.borderColor = ACCENT[(bgIndex + 2) % ACCENT.length] + "aa";
    stage.appendChild(el);
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }

  function spawnBlob(x, y) {
    if (activeBlobCount.n >= MAX_BLOBS) return;
    const color = ACCENT[Math.floor(Math.random() * ACCENT.length)];
    const path = BLOB_PATHS[Math.floor(Math.random() * BLOB_PATHS.length)];
    const el = document.createElement("div");
    el.className = "blob";
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.innerHTML =
      '<svg viewBox="0 0 100 100">' +
      '<path d="' + path + '" fill="' + color + '"/>' +
      '<circle cx="38" cy="46" r="5" fill="#2b2242"/>' +
      '<circle cx="64" cy="46" r="5" fill="#2b2242"/>' +
      '<path d="M40 60 Q50 72 62 60" stroke="#2b2242" stroke-width="4" fill="none" stroke-linecap="round"/>' +
      "</svg>";
    stage.appendChild(el);
    activeBlobCount.n++;
    el.addEventListener("animationend", () => { el.remove(); activeBlobCount.n--; }, { once: true });
  }

  function maybeCycleBackground() {
    if (!prefs.bgCycle) return;
    if (touchCount % 6 === 0) {
      let next = bgIndex;
      while (next === bgIndex) next = Math.floor(Math.random() * BG.length);
      bgIndex = next;
      stage.style.backgroundColor = BG[bgIndex];
    }
  }

  // ---- interaction ------------------------------------------------------
  function handleTouch(x, y) {
    if (!firstTouchDone) {
      firstTouchDone = true;
      startHint.classList.add("hidden");
      hideInstallHint(true);
    }
    touchCount++;
    spawnRipple(x, y);
    spawnBlob(x, y);
    const noteIndex = Math.round((x / window.innerWidth) * (NOTES.length - 1));
    playTone(noteIndex);
    maybeCycleBackground();
  }

  stage.addEventListener("pointerdown", (e) => {
    handleTouch(e.clientX, e.clientY);
  });

  // support additional simultaneous touch points beyond the primary pointer
  stage.addEventListener("touchstart", (e) => {
    for (let i = 1; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      handleTouch(t.clientX, t.clientY);
    }
  }, { passive: true });

  document.addEventListener("contextmenu", (e) => e.preventDefault());

  // ---- install hint (only relevant when not already installed) ---------
  function isStandalone() {
    return ["standalone", "fullscreen", "minimal-ui"].some(
      (mode) => window.matchMedia("(display-mode: " + mode + ")").matches
    ) || window.navigator.standalone === true;
  }

  function hideInstallHint(auto) {
    installHint.hidden = true;
    if (!auto) { prefs.installDismissed = true; savePrefs(); }
  }

  if (!isStandalone() && !prefs.installDismissed) {
    installHint.hidden = false;
  }
  document.getElementById("installHintClose").addEventListener("click", () => hideInstallHint(false));

  // ---- back gesture guard -----------------------------------------------
  // インストール済み(standalone)で遊んでいるとき、画面端からのスワイプが
  // 「戻る」ジェスチャーになってアプリから抜けてしまうのを防ぐ。
  // 端スワイプ自体はOSのジェスチャーなのでJSからは止められないため、
  // ダミーの履歴エントリを積んでおき、戻られたら積み直すことで
  // 実質的に「戻り先がない」状態を保つ。
  // ブラウザのタブで開いているときは通常どおり戻れるようにしておく。
  const GUARD_DEPTH = 3;
  let guardDepth = 0;
  let backGuardActive = false;

  function pushGuard() {
    try {
      history.pushState({ ponponGuard: true }, "");
      guardDepth++;
    } catch (e) { /* history が使えない環境では何もしない */ }
  }

  function refillGuard() {
    while (guardDepth < GUARD_DEPTH) {
      const before = guardDepth;
      pushGuard();
      if (guardDepth === before) return; // pushState 失敗 — 無限ループ回避
    }
  }

  function enableBackGuard() {
    if (backGuardActive) return;
    backGuardActive = true;
    refillGuard();
  }

  function updateBackGuard() {
    if (prefs.backGuard && isStandalone()) enableBackGuard();
    else backGuardActive = false; // 既に積んだ分は消せないが、積み直しはしない
  }

  window.addEventListener("popstate", () => {
    if (guardDepth > 0) guardDepth--;
    if (!backGuardActive) return;
    // 設定パネルが開いていれば、戻る操作は「パネルを閉じる」に割り当てる
    if (!settingsPanel.hidden) settingsPanel.hidden = true;
    refillGuard();
  });

  // ホーム画面から起動した直後は display-mode の判定が間に合わないことがあるため、
  // 表示モードが変わったタイミングでも見直す。
  ["standalone", "fullscreen", "minimal-ui"].forEach((mode) => {
    const mq = window.matchMedia("(display-mode: " + mode + ")");
    const onChange = () => updateBackGuard();
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  });

  updateBackGuard();

  // ---- parent-only settings (long-press to avoid accidental taps) ------
  let pressTimer = null;
  function startPress() {
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => { settingsPanel.hidden = false; }, 1200);
  }
  function cancelPress() { clearTimeout(pressTimer); }

  parentCorner.addEventListener("pointerdown", startPress);
  parentCorner.addEventListener("pointerup", cancelPress);
  parentCorner.addEventListener("pointerleave", cancelPress);
  parentCorner.addEventListener("pointercancel", cancelPress);
  parentCorner.addEventListener("click", (e) => e.preventDefault());

  document.getElementById("settingsClose").addEventListener("click", () => {
    settingsPanel.hidden = true;
  });
  soundToggle.addEventListener("change", () => {
    prefs.sound = soundToggle.checked;
    savePrefs();
    if (prefs.sound) ensureAudio();
  });
  bgToggle.addEventListener("change", () => {
    prefs.bgCycle = bgToggle.checked;
    savePrefs();
  });
  backGuardToggle.addEventListener("change", () => {
    prefs.backGuard = backGuardToggle.checked;
    savePrefs();
    updateBackGuard();
  });

  // ---- service worker ----------------------------------------------------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js").catch(() => {});
    });
  }
})();
