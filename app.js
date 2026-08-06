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

  // なぞり(トレイル)用
  const TRAIL_SOUND_INTERVAL = 70; // ms — これ以上は詰めて鳴らさない
  const strokes = new Map(); // pointerId -> { x, y, note }
  let lastTrailSoundAt = 0;

  // 長押し(ふくらむ顔)用
  const HOLD_DELAY = 260;      // ms これだけ押し続けたら育ちはじめる
  const HOLD_MOVE_SLOP = 14;   // px これ以上動いたら「なぞり」とみなして育てない
  const GROW_DURATION = 3200;  // ms 最大の大きさになるまで
  const GROW_MAX_SCALE = 6;    // CSS上の大きさ(14vmin)の何倍まで育つか
  const holds = new Map();     // pointerId -> hold
  let growRaf = 0;

  stage.style.backgroundColor = BG[bgIndex];

  // ---- audio ------------------------------------------------------------
  // iOS の Web Audio は制約が多いので、以下に対処している:
  //  1. resume() は非同期。suspended のまま start() すると、実際に再開した頃には
  //     エンベロープの時刻が過ぎていて無音になる → 再開してから組み立てる
  //  2. AudioContext はユーザー操作の中で作る必要がある。さらに最初の1回だけ
  //     無音バッファを鳴らさないとロックが解けないことがある
  //  3. 消音(サイレント)スイッチが入っていると Web Audio は鳴らない
  //     → audioSession を "playback" にして回避する (iOS 16.4+)
  //  4. バックグラウンドや着信のあと suspended のまま戻ってくる → 復帰時に resume
  let audioCtx = null;
  let audioUnlocked = false;

  function ensureAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
      // 消音スイッチが入っていても鳴らす。未対応環境では単に無視される
      try {
        if (navigator.audioSession) navigator.audioSession.type = "playback";
      } catch (e) { /* 一部環境では代入できないことがある */ }
    }
    if (audioCtx.state === "suspended") resumeAudio();
    return audioCtx;
  }

  function resumeAudio() {
    if (!audioCtx) return null;
    try {
      const p = audioCtx.resume();
      return p && typeof p.then === "function" ? p : Promise.resolve();
    } catch (e) {
      return null;
    }
  }

  // iOS は無音バッファを1回鳴らすまでロックが解けないことがあるので、
  // 最初のユーザー操作のなかで済ませておく
  function unlockAudio() {
    if (audioUnlocked || !prefs.sound) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    audioUnlocked = true;
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      src.connect(ctx.destination);
      src.start(0);
    } catch (e) { /* 鳴らせなくても playTone 側で再試行される */ }
  }

  ["pointerdown", "touchend", "click"].forEach((type) => {
    document.addEventListener(type, unlockAudio, { once: true, passive: true, capture: true });
  });

  function emitTone(ctx, freq) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = freq;
    osc.connect(gain).connect(ctx.destination);
    // 時刻はノードを作ったあとに読む。1音目は createOscillator に
    // 数十msかかることがあり、先に読んだ時刻だとエンベロープが過去になって
    // 無音のまま終わってしまう
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    osc.start(now);
    osc.stop(now + 0.52);
  }

  // なぞったときの音。タップの音とは別の音色にしつつ、同じ音階から選ぶので
  // 混ざっても濁らない。
  //  - 立ち上がりに軽いしゃくり上げ → 「ぽろん」と弾むような楽しい粒になる
  //  - 12度上のかすかな倍音 → きらきらした響き
  //  - 音量は控えめ + ローパスで高域を丸める → 連続で鳴っても耳に刺さらない
  //  - 触っている位置で左右に振る → なぞった軌跡が音でも動く
  //
  // 素早くなぞると音が重なるので、まとめてコンプレッサーに通してから出す。
  // (重なった瞬間だけ音量が跳ね上がって驚かせてしまうのを防ぐ)
  let sparkleBus = null;
  function sparkleOutput(ctx) {
    // AudioContext は作り直されないが、念のため取り違えを防いでおく
    if (sparkleBus && sparkleBus.context === ctx) return sparkleBus;
    if (!ctx.createDynamicsCompressor) return ctx.destination;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.knee.value = 30;
    comp.ratio.value = 12;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    comp.connect(ctx.destination);
    sparkleBus = comp;
    return comp;
  }

  function emitSparkle(ctx, freq, pan) {
    const osc = ctx.createOscillator();
    const shine = ctx.createOscillator();
    const gain = ctx.createGain();
    const shineGain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    filter.type = "lowpass";
    filter.frequency.value = 4200;
    filter.Q.value = 0.6;

    let out = filter;
    // StereoPanner が無い環境 (古いiOSなど) では左右振りだけ省く
    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      filter.connect(panner);
      out = panner;
    }
    out.connect(sparkleOutput(ctx));

    osc.type = "sine";
    shine.type = "sine";
    osc.connect(gain).connect(filter);
    shine.connect(shineGain).connect(filter);

    const now = ctx.currentTime;
    osc.frequency.setValueAtTime(freq * 0.72, now);
    osc.frequency.exponentialRampToValueAtTime(freq, now + 0.05);
    shine.frequency.setValueAtTime(freq * 3, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.13, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);

    shineGain.gain.setValueAtTime(0.0001, now);
    shineGain.gain.exponentialRampToValueAtTime(0.035, now + 0.006);
    shineGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

    osc.start(now);
    shine.start(now);
    osc.stop(now + 0.34);
    shine.stop(now + 0.34);
  }

  // 長押しで顔が育っているあいだ、ずっと鳴らしている音。
  // ふくらんでいく感じが出るよう、育つ時間をかけてゆっくり音程を上げる。
  // 音程の変化は最初にまとめて予約しておく (毎フレーム指定すると重いため)。
  // わずかにずらした2音を重ねてやわらかい音色にし、ローパスで角を丸めている。
  function startGrowVoice(hold) {
    playSound((ctx) => {
      // 音を出す準備ができるより先に指が離されていたら、もう鳴らさない
      if (!hold.growing) return;

      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 2600;
      filter.Q.value = 0.7;

      const gain = ctx.createGain();
      filter.connect(gain).connect(sparkleOutput(ctx));

      const oscs = [0, 6].map((detune) => {
        const o = ctx.createOscillator();
        o.type = "triangle";
        o.detune.value = detune;
        o.connect(filter);
        return o;
      });

      const now = ctx.currentTime;
      oscs.forEach((o) => {
        o.frequency.setValueAtTime(hold.note, now);
        o.frequency.exponentialRampToValueAtTime(hold.note * 2, now + GROW_DURATION / 1000);
        o.start(now);
      });

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.085, now + 0.12);

      hold.voice = { ctx: ctx, gain: gain, oscs: oscs };
    });
  }

  function stopGrowVoice(hold) {
    const v = hold.voice;
    hold.voice = null;
    if (!v) return;
    const now = v.ctx.currentTime;
    try {
      v.gain.gain.cancelScheduledValues(now);
      // 現在の音量から始めないと、切った瞬間にプツッと鳴ってしまう
      v.gain.gain.setValueAtTime(Math.max(v.gain.gain.value, 0.0001), now);
      v.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
      v.oscs.forEach((o) => o.stop(now + 0.1));
    } catch (e) { /* すでに止まっていることがある */ }
  }

  // 離したときの「ぽんっ」。大きく育っているほど低く、重たい音になる
  function emitPop(ctx, freq) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 2400;
    filter.Q.value = 0.7;
    osc.type = "sine";
    osc.connect(gain).connect(filter).connect(sparkleOutput(ctx));

    const now = ctx.currentTime;
    osc.frequency.setValueAtTime(freq * 1.7, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.85, now + 0.09);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.2, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    osc.start(now);
    osc.stop(now + 0.32);
  }

  // emit は ctx を受け取って鳴らすだけの関数。
  // suspended のときは再開を待ってから呼ぶ (時刻を再開後に読む必要があるため)
  function playSound(emit) {
    if (!prefs.sound) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    if (ctx.state === "running") {
      emit(ctx);
      return;
    }
    // まだ再開していないので、再開を待ってから鳴らす
    const p = resumeAudio();
    if (!p) return;
    p.then(() => {
      if (prefs.sound && ctx.state === "running") emit(ctx);
    }).catch(() => {});
  }

  function playTone(freqIndex) {
    const freq = NOTES[Math.max(0, Math.min(NOTES.length - 1, freqIndex))];
    playSound((ctx) => emitTone(ctx, freq));
  }

  function playSparkle(noteIndex, x) {
    // タップより1オクターブ上。軽やかで、タップの音と聞き分けやすい
    const freq = NOTES[Math.max(0, Math.min(NOTES.length - 1, noteIndex))] * 2;
    const pan = ((x / window.innerWidth) * 2 - 1) * 0.7;
    playSound((ctx) => emitSparkle(ctx, freq, pan));
  }

  function playPop(note, grownRatio) {
    const freq = note * (1.5 - 0.7 * Math.max(0, Math.min(1, grownRatio)));
    playSound((ctx) => emitPop(ctx, freq));
  }

  // 着信やホームに戻ったあとは suspended のまま戻ってくることがある
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && audioCtx && audioCtx.state === "suspended") resumeAudio();
  });

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

  // タップで出る顔。なぞりの軌跡もこれと同じ顔を小さくして使う
  function faceSVG() {
    const color = ACCENT[Math.floor(Math.random() * ACCENT.length)];
    const path = BLOB_PATHS[Math.floor(Math.random() * BLOB_PATHS.length)];
    return (
      '<svg viewBox="0 0 100 100">' +
      '<path d="' + path + '" fill="' + color + '"/>' +
      '<circle cx="38" cy="46" r="5" fill="#2b2242"/>' +
      '<circle cx="64" cy="46" r="5" fill="#2b2242"/>' +
      '<path d="M40 60 Q50 72 62 60" stroke="#2b2242" stroke-width="4" fill="none" stroke-linecap="round"/>' +
      "</svg>"
    );
  }

  function spawnBlob(x, y) {
    if (activeBlobCount.n >= MAX_BLOBS) return;
    const el = document.createElement("div");
    el.className = "blob";
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.innerHTML = faceSVG();
    stage.appendChild(el);
    activeBlobCount.n++;
    el.addEventListener("animationend", () => { el.remove(); activeBlobCount.n--; }, { once: true });
  }

  // なぞった軌跡に置く小さい顔。個数の上限は設けず、なぞった分だけ出す。
  // (波紋と同じく、アニメーションが終わったものから消えていく)
  function spawnTrailFace(x, y) {
    const el = document.createElement("div");
    el.className = "blob trail";
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.style.setProperty("--rot", (Math.random() * 40 - 20).toFixed(1) + "deg");
    el.innerHTML = faceSVG();
    stage.appendChild(el);
    el.addEventListener("animationend", () => el.remove(), { once: true });
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

  // ---- なぞり ------------------------------------------------------------
  // 指を滑らせているあいだ、通ったところに顔を置いていく。
  // 指ごとに前回置いた位置を覚えておき、一定距離すすむたびに1つ置く。
  // (イベントごとに置くと端末の性能で密度が変わってしまうため)

  // 画面サイズに対する間隔。小さい画面で出過ぎないようにしている
  function trailStep() {
    return Math.max(22, Math.min(window.innerWidth, window.innerHeight) * 0.06);
  }

  function strokeStart(id, x, y) {
    // 音は指ごとに低い音から始めて、なぞるほど上がっていく
    strokes.set(id, { x: x, y: y, note: Math.floor(Math.random() * 3) });
  }

  function strokeMove(id, x, y) {
    const s = strokes.get(id);
    if (!s) return;
    const step = trailStep();
    const dx = x - s.x;
    const dy = y - s.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < step) return;

    // 速く動かしたときに軌跡が飛ばないよう、間を埋めながら置く。
    // ただし一気に動かされたときのために置く数は制限する
    const count = Math.min(Math.floor(dist / step), 4);
    for (let i = 1; i <= count; i++) {
      const t = (step * i) / dist;
      spawnTrailFace(s.x + dx * t, s.y + dy * t);
    }
    const moved = (step * count) / dist;
    s.x += dx * moved;
    s.y += dy * moved;

    const now = Date.now();
    if (now - lastTrailSoundAt >= TRAIL_SOUND_INTERVAL) {
      lastTrailSoundAt = now;
      playSparkle(s.note, x);
    }
    s.note = (s.note + 1) % NOTES.length;
  }

  function strokeEnd(id) {
    strokes.delete(id);
  }

  // ---- 長押し ------------------------------------------------------------
  // 指を置いたままにしていると、その場で顔がどんどん大きくなっていく。
  // 育っているあいだは顔が指についてくる。離すと「ぽんっ」と弾けて消える。
  // 指を動かしたときは「なぞり」のほうをしたいはずなので、育てはじめない。

  function holdStart(id, x, y) {
    const hold = {
      x: x, y: y, originX: x, originY: y,
      growing: false, el: null, voice: null, startAt: 0, scale: 1,
      note: NOTES[Math.floor(Math.random() * 4)],
    };
    hold.timer = setTimeout(() => growStart(id), HOLD_DELAY);
    holds.set(id, hold);
  }

  function growStart(id) {
    const hold = holds.get(id);
    if (!hold) return;
    hold.growing = true;
    hold.startAt = performance.now();
    // 育てているあいだは、なぞりの軌跡は出さない
    strokes.delete(id);

    const el = document.createElement("div");
    el.className = "blob grow";
    el.style.left = hold.x + "px";
    el.style.top = hold.y + "px";
    el.innerHTML = faceSVG();
    stage.appendChild(el);
    hold.el = el;

    startGrowVoice(hold);
    if (!growRaf) growRaf = requestAnimationFrame(growTick);
  }

  function growTick(now) {
    growRaf = 0;
    let growing = false;
    holds.forEach((hold) => {
      if (!hold.growing) return;
      growing = true;
      const p = Math.min((now - hold.startAt) / GROW_DURATION, 1);
      // はじめは勢いよく、だんだんゆっくり大きくなる
      const eased = 1 - Math.pow(1 - p, 2);
      // 大きくなるほど、ゆっくり呼吸しているように揺れる
      const breath = 1 + Math.sin(now / 380) * 0.02 * p;
      hold.scale = (1 + (GROW_MAX_SCALE - 1) * eased) * breath;
      hold.el.style.transform = "translate(-50%, -50%) scale(" + hold.scale.toFixed(3) + ")";
    });
    if (growing) growRaf = requestAnimationFrame(growTick);
  }

  function holdMove(id, x, y) {
    const hold = holds.get(id);
    if (!hold) return;
    if (hold.growing) {
      // 育っている顔は指についてくる
      hold.x = x;
      hold.y = y;
      hold.el.style.left = x + "px";
      hold.el.style.top = y + "px";
      return;
    }
    const dx = x - hold.originX;
    const dy = y - hold.originY;
    if (Math.sqrt(dx * dx + dy * dy) > HOLD_MOVE_SLOP) {
      clearTimeout(hold.timer);
      holds.delete(id);
    }
  }

  function holdEnd(id) {
    const hold = holds.get(id);
    if (!hold) return;
    holds.delete(id);
    clearTimeout(hold.timer);
    if (!hold.growing) return;
    // 音を出す準備を待っているコールバックにも、もう鳴らさないことを伝える
    hold.growing = false;

    stopGrowVoice(hold);
    playPop(hold.note, (hold.scale - 1) / (GROW_MAX_SCALE - 1));
    spawnRipple(hold.x, hold.y);

    // いま育っている大きさから弾けさせる
    const el = hold.el;
    el.style.setProperty("--s", hold.scale.toFixed(3));
    el.classList.add("popping");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }

  // 押しっぱなしのままアプリが隠れると、音が鳴り続けたまま戻ってこられなくなる
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) holds.forEach((hold, id) => holdEnd(id));
  });

  stage.addEventListener("pointerdown", (e) => {
    handleTouch(e.clientX, e.clientY);
    strokeStart(e.pointerId, e.clientX, e.clientY);
    holdStart(e.pointerId, e.clientX, e.clientY);
    // 指が #stage の外 (保護者用ボタンの上など) へ出ても追い続けられるようにする
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* 捕捉できなくても軌跡が途切れるだけ */ }
  });

  // Pointer Events は指ごとに pointerId 付きで飛んでくるので、
  // 多点タッチでもそれぞれの軌跡がそのまま扱える
  stage.addEventListener("pointermove", (e) => {
    holdMove(e.pointerId, e.clientX, e.clientY);
    strokeMove(e.pointerId, e.clientX, e.clientY);
  });

  ["pointerup", "pointercancel", "lostpointercapture"].forEach((type) => {
    stage.addEventListener(type, (e) => {
      holdEnd(e.pointerId);
      strokeEnd(e.pointerId);
    });
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
  //
  // ただし Chrome には「ユーザー操作なしで積んだ履歴エントリは、戻る操作の
  // ときにスキップする」という介入 (History Manipulation Intervention) がある。
  // 読み込み時や popstate の中で積んだエントリは素通りされてしまうため、
  // Android の PWA では戻るジェスチャーでアプリから抜けていた。
  // → 積むのは「ユーザー操作の最中」だけにする。このアプリは画面を
  //    タップして遊ぶものなので、タップのたびに補充すれば深さを保てる。
  const GUARD_DEPTH = 3;
  let guardDepth = 0;
  let backGuardActive = false;

  function pushGuard() {
    try {
      history.pushState({ ponponGuard: true }, "");
      guardDepth++;
    } catch (e) { /* history が使えない環境では何もしない */ }
  }

  function hasUserActivation() {
    const ua = navigator.userActivation;
    // 判定できない環境 (Safari など) には上記の介入自体がないので、そのまま積む
    return ua ? ua.isActive : true;
  }

  // ユーザー操作の最中だけ、足りない分を積み直す
  function topUpGuard() {
    if (!backGuardActive || !hasUserActivation()) return;
    while (guardDepth < GUARD_DEPTH) {
      const before = guardDepth;
      pushGuard();
      if (guardDepth === before) return; // pushState 失敗 — 無限ループ回避
    }
  }

  function updateBackGuard() {
    backGuardActive = !!(prefs.backGuard && isStandalone());
    // 既に積んだ分は消せないが、無効化したあとは積み直さない
    topUpGuard();
  }

  // タップのたびに補充する。pointerdown だけだと操作扱いにならない場合が
  // あるので、touchend / click でも受ける
  ["pointerdown", "touchend", "click"].forEach((type) => {
    document.addEventListener(type, topUpGuard, { capture: true, passive: true });
  });

  window.addEventListener("popstate", () => {
    if (guardDepth > 0) guardDepth--;
    if (!backGuardActive) return;
    // 設定パネルが開いていれば、戻る操作は「パネルを閉じる」に割り当てる
    if (!settingsPanel.hidden) settingsPanel.hidden = true;
    // ここは通常ユーザー操作の外なので積めない。次のタップで補充される
    topUpGuard();
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
    // トグル操作もユーザー操作なので、ここでロックを解いておく
    if (prefs.sound) unlockAudio();
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

  // ---- service worker / 更新のフィードバック --------------------------------
  // Service Worker が cache-first なので、デプロイしても端末に新しい版が
  // 届いたのかが分からない。いま動いているバージョンと更新状態を
  // 保護者用設定に表示し、新しい版を見つけたらバナーで知らせる。
  //
  // ※ リリース時は service-worker.js の APP_VERSION も同じ値へ上げること。
  //    (バージョン文字列がキャッシュ名に入っているので、上げないと
  //     インストール済み端末に新しいファイルが届かない)
  const APP_VERSION = "1.3.0";

  const versionLabel = document.getElementById("versionLabel");
  const updateStatus = document.getElementById("updateStatus");
  const updateCheck = document.getElementById("updateCheck");
  const updateApply = document.getElementById("updateApply");
  const updateBanner = document.getElementById("updateBanner");
  const updateBannerText = document.getElementById("updateBannerText");

  const MIN_CHECK_INTERVAL = 60 * 1000;

  let swRegistration = null;
  let waitingWorker = null;
  let lastCheckAt = 0;
  let reloading = false;
  let bannerTimer = null;

  versionLabel.textContent = "v" + APP_VERSION;

  function setStatus(text, state) {
    updateStatus.textContent = text;
    updateStatus.dataset.state = state;
  }

  function showBanner(text, autoHideMs) {
    updateBannerText.textContent = text;
    updateBanner.hidden = false;
    clearTimeout(bannerTimer);
    if (autoHideMs) bannerTimer = setTimeout(() => { updateBanner.hidden = true; }, autoHideMs);
  }

  document.getElementById("updateBannerClose").addEventListener("click", () => {
    clearTimeout(bannerTimer);
    updateBanner.hidden = true;
  });

  // 更新のために再読み込みした直後は、その旨を知らせる
  try {
    if (sessionStorage.getItem("ponpon-updated")) {
      sessionStorage.removeItem("ponpon-updated");
      showBanner("v" + APP_VERSION + " に更新しました", 6000);
    }
  } catch (e) { /* sessionStorage が使えない環境では黙って諦める */ }

  function reloadForUpdate() {
    if (reloading) return;
    reloading = true;
    try { sessionStorage.setItem("ponpon-updated", "1"); } catch (e) {}
    location.reload();
  }

  function markUpdateReady(worker) {
    waitingWorker = worker;
    setStatus("新しいバージョンがあります", "ready");
    updateApply.hidden = false;
    showBanner("新しいバージョンがあります（保護者用設定から更新）");
  }

  function applyUpdate() {
    if (!waitingWorker) { reloadForUpdate(); return; }
    setStatus("更新しています…", "checking");
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
    // controllerchange が届かない環境向けの保険
    setTimeout(reloadForUpdate, 3000);
  }

  function checkForUpdate(manual) {
    if (!swRegistration) return;
    if (waitingWorker) return; // すでに更新待ち
    // オフラインだと update() が確認せずに解決してしまうことがあり、
    // 「最新です」と出ると誤解を招くので先に弾く
    if (navigator.onLine === false) {
      setStatus("オフラインです（確認できません）", "error");
      return;
    }
    const now = Date.now();
    if (!manual && now - lastCheckAt < MIN_CHECK_INTERVAL) return;
    lastCheckAt = now;
    setStatus("確認しています…", "checking");
    swRegistration.update()
      .then(() => {
        if (waitingWorker || swRegistration.installing || swRegistration.waiting) return;
        setStatus("最新です", "latest");
      })
      .catch(() => setStatus("確認できませんでした（オフライン？）", "error"));
  }

  function trackWorker(worker) {
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      // 既存の Service Worker がいる状態での installed = 更新版が用意できた
      if (worker.state === "installed" && navigator.serviceWorker.controller) {
        markUpdateReady(worker);
      }
    });
  }

  updateCheck.addEventListener("click", () => checkForUpdate(true));
  updateApply.addEventListener("click", applyUpdate);

  if ("serviceWorker" in navigator) {
    // 初回登録時は clients.claim() でも controllerchange が起きるため、
    // 「もともと制御されていた」ときだけ再読み込みする
    const hadController = !!navigator.serviceWorker.controller;

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadController) reloadForUpdate();
    });

    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js")
        .then((reg) => {
          swRegistration = reg;
          if (reg.waiting && navigator.serviceWorker.controller) markUpdateReady(reg.waiting);
          trackWorker(reg.installing);
          reg.addEventListener("updatefound", () => trackWorker(reg.installing));
          checkForUpdate(true);
        })
        .catch(() => setStatus("確認できませんでした", "error"));
    });

    // アプリは開きっぱなしになりやすいので、前面に戻るたびに確認する
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) checkForUpdate(false);
    });
  } else {
    setStatus("この環境では自動更新に対応していません", "error");
    updateCheck.hidden = true;
  }
})();
