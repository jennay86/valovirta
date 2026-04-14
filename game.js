(() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d", { alpha: false });

  const scoreEl = document.getElementById("score");
  const btnRestart = document.getElementById("btnRestart");
  const btnMenu = document.getElementById("btnMenu");
  const menu = document.getElementById("menu");
  const btnStart = document.getElementById("btnStart");
  const titleEl = document.getElementById("title");
  const hintEl = document.getElementById("hint");
  const dailyChallengeEl = document.getElementById("dailyChallenge");

  // --- Canvas sizing (portrait-friendly) ---
  function resize() {
    const dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
    const w = Math.floor(window.innerWidth * dpr);
    const h = Math.floor(window.innerHeight * dpr);
    canvas.width = w;
    canvas.height = h;
  }
  window.addEventListener("resize", resize, { passive: true });
  resize();

  // --- Game constants ---
  const LANES = 2; // LEFT/RIGHT
  const baseLaneOffset = 140; // px in world units (scaled by DPR implicitly via canvas)
  const playerRadius = 14;
  const gateHalfWidth = 64;   // visual gate width
  const hazardRadius = 22;

  // Difficulty / rhythm tuning
  const startSpeed = 520;         // px/s
  const speedRampPerSec = 12.5;   // +px/s per second survived
  const minSpawnDistance = 260;   // distance between events
  const maxSpawnDistance = 420;
  const earlyEaseDuration = 22;   // first seconds are intentionally softer

  const startWobbleAmp = 0;
  const maxWobbleAmp = 110;
  const wobbleRampPerSec = 6.5; // how fast wobble increases
  const wobbleFreq = 0.9;       // Hz-ish

  // Gate decisions are resolved exactly when crossing the gate line.
  const gateScore = 10;
  const hazardScore = 6;
  const hazardPenalty = 5;  // points lost on hazard hit
  const bonusScore = 20;
  const bonusChainStep = 3;
  const nearMissWindow = 55;
  const nearMissScore = 5;
  const dailyChallengeRewardScore = 50;
  const bonusRadius = 14;
  const leaderboardKey = "valovirta_top5";
  const dailyChallengeKey = "valovirta_daily_challenge_v1";
  const dailyChallengePool = [
    { id: "gates_100", metric: "gates", target: 100, text: "Läpäise 100 porttia" },
    { id: "bonus_20", metric: "bonus", target: 20, text: "Kerää 20 bonuspalloa" },
    { id: "perfect_10", metric: "perfect", target: 10, text: "Saa 10 viime hetken bonusta" },
  ];
  const hazardHitSfx = "assets/boom.mp3";
  const bonusCollectSfx = "assets/booster.mp3";
  const mainMusicTrack = "assets/main_music.mp3";
  const mainMusicEndTrack = "assets/main_music_end.mp3";
  const backgroundTracks = [
    "assets/back1.mp3",
    "assets/back2.mp3",
    "assets/back3.mp3",
    "assets/back4.mp3",
    "assets/back5.mp3",
  ];

  // --- State ---
  let running = false;
  let gameOver = false;
  let menuVisible = true;

  // Hide menu button initially (show only during game)
  btnMenu.style.display = "none";
  btnRestart.style.display = "none";

  let t = 0;          // seconds
  let lastTs = 0;
  let score = 0;
  let leaderboard = [];
  let latestRank = null;
  let leaderboardChecked = false;
  let backgroundMusic = null;
  let mainMusic = null;
  let displayX = null;
  const playerTrail = [];
  let lastLaneSwitchY = -1e9;
  let lastLaneSwitchTo = -1;
  let nearMissPopupTimer = 0;
  let gatesPassed = 0;
  let bonusChain = 0;
  let bonusChainPopup = "";
  let bonusChainPopupTimer = 0;
  let nextMilestone = 100;
  let milestonePulse = 0;
  let pointsToBest = null;
  let dailyChallenge = null;
  let dailyChallengePopup = "";
  let dailyChallengePopupTimer = 0;

  function milestoneStep(target) {
    if (target < 300) return 100;
    if (target < 800) return 150;
    return 200;
  }

  function dayStamp() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function pickChallengeForDay(stamp) {
    const seed = Number(stamp.replaceAll("-", "")) || 0;
    const def = dailyChallengePool[seed % dailyChallengePool.length];
    return {
      day: stamp,
      id: def.id,
      metric: def.metric,
      target: def.target,
      text: def.text,
      progress: 0,
      completed: false,
    };
  }

  function saveDailyChallenge() {
    if (!dailyChallenge) return;
    try {
      localStorage.setItem(dailyChallengeKey, JSON.stringify(dailyChallenge));
    } catch {
      // Ignore storage errors.
    }
  }

  function renderDailyChallengePanel() {
    if (!dailyChallengeEl || !dailyChallenge) return;
    const progress = Math.min(dailyChallenge.progress, dailyChallenge.target);
    const status = dailyChallenge.completed ? "Valmis" : `${progress}/${dailyChallenge.target}`;
    dailyChallengeEl.classList.toggle("done", dailyChallenge.completed);
    dailyChallengeEl.innerHTML =
      `<div class="dc-title">Päivän haaste</div>` +
      `<div class="dc-body">${dailyChallenge.text}</div>` +
      `<div class="dc-progress">${status}</div>` +
      `<div class="dc-reward">Palkinto +${dailyChallengeRewardScore} p</div>`;
  }

  function loadDailyChallenge() {
    const today = dayStamp();
    let next = null;
    let shouldSave = false;

    try {
      const raw = localStorage.getItem(dailyChallengeKey);
      const parsed = raw ? JSON.parse(raw) : null;
      if (
        parsed &&
        parsed.day === today &&
        typeof parsed.metric === "string" &&
        Number.isFinite(parsed.target) &&
        Number.isFinite(parsed.progress)
      ) {
        const def = dailyChallengePool.find((item) => item.metric === parsed.metric);
        if (def) {
          const progress = Math.max(0, Math.min(parsed.progress, def.target));
          const completed = Boolean(parsed.completed) || progress >= def.target;
          next = {
            day: today,
            id: def.id,
            metric: def.metric,
            target: def.target,
            text: def.text,
            progress,
            completed,
          };
          shouldSave =
            parsed.id !== def.id ||
            parsed.target !== def.target ||
            parsed.text !== def.text ||
            parsed.progress !== progress ||
            Boolean(parsed.completed) !== completed;
        }
      }
    } catch {
      next = null;
    }

    if (!next) {
      next = pickChallengeForDay(today);
      dailyChallenge = next;
      saveDailyChallenge();
    } else {
      dailyChallenge = next;
      if (shouldSave) saveDailyChallenge();
    }

    renderDailyChallengePanel();
  }

  function updateDailyChallenge(metric, amount = 1) {
    if (!dailyChallenge) return;
    if (dailyChallenge.completed) return;
    if (dailyChallenge.metric !== metric) return;

    dailyChallenge.progress = Math.min(dailyChallenge.target, dailyChallenge.progress + amount);
    if (dailyChallenge.progress >= dailyChallenge.target) {
      dailyChallenge.completed = true;
      score += dailyChallengeRewardScore;
      dailyChallengePopup = `PÄIVÄN HAASTE VALMIS  +${dailyChallengeRewardScore} p`;
      dailyChallengePopupTimer = 1.4;
      milestonePulse = Math.max(milestonePulse, 0.75);
    }

    saveDailyChallenge();
    renderDailyChallengePanel();
  }

  // Player in "world" space: x is lane-based, y increases forward; camera follows y.
  const player = {
    lane: 0,      // 0=LEFT, 1=RIGHT
    y: 0,
    alive: true,
  };

  // Events are placed along y axis ahead of player
  // type: 'gate' or 'hazard'
  // lane: 0/1, and for gate, openLane indicates safe lane
  const events = [];
  let nextEventY = 700;

  // For feel: a subtle pulse synchronized to an internal BPM that increases with speed.
  function bpmFromSpeed(speed) {
    // 120 BPM at start, up to ~175
    return Math.min(175, 120 + (speed - startSpeed) * 0.055);
  }

  function rand(min, max) { return min + Math.random() * (max - min); }
  function choice(arr) { return arr[(Math.random() * arr.length) | 0]; }

  function difficultyProgress() {
    // Slow, steady baseline increase over ~2 minutes.
    return Math.min(1, t / 120);
  }

  function currentSpeed() {
    const p = difficultyProgress();
    const earlyEase = Math.min(1, t / earlyEaseDuration);
    const wave = Math.sin(t * 0.55) * (0.03 + 0.09 * p);
    const base = startSpeed + t * speedRampPerSec;
    const scale = 1 + p * 0.22 + wave;
    const softStart = 0.78 + 0.22 * earlyEase;
    return base * Math.max(0.86, scale) * softStart;
  }

  function currentSpawnDistanceRange() {
    const p = difficultyProgress();
    const earlyEase = Math.min(1, t / earlyEaseDuration);
    const wave = Math.sin(t * 0.42 + 1.2) * (0.04 + 0.10 * p);
    const pressure = Math.max(0.72, 1 + p * 0.26 + wave);
    const starterBreath = 1 + (1 - earlyEase) * 0.20;
    const minDist = Math.max(170, Math.floor((minSpawnDistance / pressure) * starterBreath));
    const maxDist = Math.max(minDist + 60, Math.floor((maxSpawnDistance / pressure) * starterBreath));
    return { minDist, maxDist };
  }

  function pickRandomTrack(currentSrc = "") {
    const pool = backgroundTracks.filter((track) => !currentSrc.endsWith(track));
    return choice(pool.length > 0 ? pool : backgroundTracks);
  }

  function stopBackgroundMusic() {
    if (!backgroundMusic) return;
    backgroundMusic.pause();
    backgroundMusic.currentTime = 0;
  }

  function playMainMusic(track = mainMusicTrack) {
    if (!mainMusic) {
      mainMusic = new Audio(track);
      mainMusic.loop = true;
      mainMusic.volume = 0.28;
    }
    if (!mainMusic.src.endsWith(track)) {
      mainMusic.src = track;
    }
    mainMusic.currentTime = 0;
    mainMusic.play().catch(() => {});
  }

  function stopMainMusic() {
    if (!mainMusic) return;
    mainMusic.pause();
    mainMusic.currentTime = 0;
  }

  function playBackgroundMusic() {
    if (!backgroundMusic) {
      backgroundMusic = new Audio();
      backgroundMusic.volume = 0.32;
      backgroundMusic.addEventListener("ended", () => {
        if (!running || menuVisible || gameOver) return;
        backgroundMusic.src = pickRandomTrack(backgroundMusic.src);
        backgroundMusic.currentTime = 0;
        backgroundMusic.play().catch(() => {});
      });
    }

    backgroundMusic.src = pickRandomTrack(backgroundMusic.src);
    backgroundMusic.currentTime = 0;
    backgroundMusic.play().catch(() => {});
  }

  function playSfx(src, volume) {
    const sfx = new Audio(src);
    sfx.volume = volume;
    sfx.play().catch(() => {});
  }

  function unlockAudioOnce() {
    if (menuVisible || gameOver) {
      playMainMusic(gameOver ? mainMusicEndTrack : mainMusicTrack);
    }
  }

  function loadLeaderboard() {
    try {
      const raw = localStorage.getItem(leaderboardKey);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((v) => Number.isFinite(v) && v >= 0)
        .map((v) => Math.floor(v))
        .sort((a, b) => b - a)
        .slice(0, 5);
    } catch {
      return [];
    }
  }

  function saveLeaderboard() {
    localStorage.setItem(leaderboardKey, JSON.stringify(leaderboard));
  }

  function updateLeaderboardForScore() {
    if (leaderboardChecked || score <= 0) return;

    leaderboardChecked = true;
    latestRank = null;

    const next = [...leaderboard];
    let insertAt = next.findIndex((value) => score >= value);

    if (insertAt === -1) {
      if (next.length < 5) {
        insertAt = next.length;
        next.push(score);
      }
    } else {
      next.splice(insertAt, 0, score);
    }

    if (insertAt !== -1) {
      if (next.length > 5) next.pop();
      leaderboard = next;
      latestRank = insertAt + 1;
      saveLeaderboard();
    }
  }

  function handleGameOver() {
    gameOver = true;
    player.alive = false;
    btnMenu.style.display = "block";
    btnRestart.style.display = "block";
    running = true; // still render
    const bestScore = leaderboard.length > 0 ? leaderboard[0] : 0;
    pointsToBest = Math.max(0, bestScore - score);
    updateLeaderboardForScore();
    stopBackgroundMusic();
    playMainMusic(mainMusicEndTrack);
  }

  function startGame() {
    menuVisible = false;
    menu.classList.add("menu-hidden");
    btnMenu.style.display = "none";
    btnRestart.style.display = "none";
    titleEl.style.display = "none";
    hintEl.style.display = "none";
    running = true;
    stopMainMusic();
    reset();
    playBackgroundMusic();
  }

  function returnToMenu() {
    menuVisible = true;
    titleEl.style.display = "block";
    hintEl.style.display = "block";
    menu.classList.remove("menu-hidden");
    btnMenu.style.display = "none";
    running = false;
    gameOver = false;
    stopBackgroundMusic();
    playMainMusic(mainMusicTrack);
  }

  function reset() {
    running = true;
    gameOver = false;
    btnMenu.style.display = "none";
    t = 0;
    lastTs = 0;
    score = 0;
    latestRank = null;
    leaderboardChecked = false;
    lastLaneSwitchY = -1e9;
    lastLaneSwitchTo = -1;
    nearMissPopupTimer = 0;
    gatesPassed = 0;
    bonusChain = 0;
    bonusChainPopup = "";
    bonusChainPopupTimer = 0;
    dailyChallengePopup = "";
    dailyChallengePopupTimer = 0;
    nextMilestone = 100;
    milestonePulse = 0;
    pointsToBest = null;

    player.lane = 0;
    player.y = 0;
    player.alive = true;

    events.length = 0;
    playerTrail.length = 0;
    displayX = null;
    nextEventY = 700;
    scoreEl.textContent = score.toString();

    // Prime with some easy pattern
    for (let i = 0; i < 8; i++) spawnEvent();
  }

  function spawnEvent() {
    // alternate between gates and hazards, with a bit of controlled randomness
    // occasionally add a bonus ball
    const p = difficultyProgress();
    const earlyEase = Math.min(1, t / 20);
    let type;
    if (Math.random() < 0.12) {
      type = "bonus";
    } else if (events.length % 2 === 0) {
      type = "gate";
    } else {
      // Hazard chance starts gentler and rises over time.
      const baseHazardChance = 0.30 + p * 0.25;
      const softStartReduction = (1 - earlyEase) * 0.12;
      const hazardChance = Math.max(0.18, baseHazardChance - softStartReduction);
      type = Math.random() < hazardChance ? "hazard" : "gate";
    }

    const y = nextEventY;

    if (type === "gate") {
      const openLane = Math.random() < 0.5 ? 0 : 1;
      events.push({ type: "gate", y, openLane, resolved: false, scored: false });
    } else if (type === "hazard") {
      // hazard occupies one lane
      const lane = Math.random() < 0.5 ? 0 : 1;
      events.push({ type: "hazard", y, lane, hit: false, passed: false });
    } else if (type === "bonus") {
      // bonus ball random lane, can be collected
      const lane = Math.random() < 0.5 ? 0 : 1;
      events.push({ type: "bonus", y, lane, collected: false });
    }

    const { minDist, maxDist } = currentSpawnDistanceRange();
    nextEventY += rand(minDist, maxDist);
  }

  function toggleLane() {
    if (!running) return;
    if (gameOver) return;

    player.lane = 1 - player.lane;
    lastLaneSwitchY = player.y;
    lastLaneSwitchTo = player.lane;
  }

  // Input
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" || e.code === "Enter") {
      e.preventDefault();
      if (menuVisible) {
        startGame();
      } else if (!gameOver) {
        toggleLane();
      }
    }
  }, { passive: false });

  window.addEventListener("pointerdown", unlockAudioOnce, { once: true, passive: true });
  window.addEventListener("keydown", unlockAudioOnce, { once: true });

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (!menuVisible && !gameOver) {
      toggleLane();
    }
  }, { passive: false });

  btnStart.addEventListener("click", (e) => {
    e.preventDefault();
    startGame();
  });

  btnMenu.addEventListener("click", (e) => {
    e.preventDefault();
    returnToMenu();
  });

  btnRestart.addEventListener("click", (e) => {
    e.preventDefault();
    btnMenu.style.display = "none";
    btnRestart.style.display = "none";
    reset();
    stopMainMusic();
    if (!menuVisible) playBackgroundMusic();
  });

  // --- Rendering helpers ---
  function laneX(lane, wobbleX) {
    const cx = canvas.width * 0.5 + wobbleX;
    return cx + (lane === 0 ? -baseLaneOffset : baseLaneOffset);
  }

  // --- Depth layer particles (parallax background) ---
  const depthLayers = [
    { parallax: 0.04, count: 60, minR: 0.0008, maxR: 0.0017, minA: 0.08, maxA: 0.22 },
    { parallax: 0.14, count: 38, minR: 0.0013, maxR: 0.0030, minA: 0.15, maxA: 0.40 },
    { parallax: 0.30, count: 22, minR: 0.0020, maxR: 0.0048, minA: 0.22, maxA: 0.58 },
  ];

  function initDepthLayers() {
    for (const layer of depthLayers) {
      layer.particles = [];
      for (let i = 0; i < layer.count; i++) {
        layer.particles.push({
          x:            Math.random(),
          baseY:        Math.random(),
          r:            layer.minR + Math.random() * (layer.maxR - layer.minR),
          a:            layer.minA + Math.random() * (layer.maxA - layer.minA),
          twinkleSpeed: 0.35 + Math.random() * 1.1,
          twinklePhase: Math.random() * Math.PI * 2,
        });
      }
    }
  }

  function drawDepthLayers(cameraY) {
    for (const layer of depthLayers) {
      if (!layer.particles) continue;
      for (const p of layer.particles) {
        const sx = p.x * canvas.width;
        const rawY = p.baseY * canvas.height - cameraY * layer.parallax;
        const sy = ((rawY % canvas.height) + canvas.height) % canvas.height;
        const tw = 0.62 + 0.38 * Math.sin(t * p.twinkleSpeed + p.twinklePhase);
        const alpha = p.a * tw;
        const pr = p.r * canvas.width;
        ctx.beginPath();
        ctx.arc(sx, sy, pr, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(180,220,255,${alpha.toFixed(3)})`;
        ctx.fill();
      }
    }
  }

  function background() {
    ctx.fillStyle = "#05060a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // subtle vignette
    const g = ctx.createRadialGradient(
      canvas.width * 0.5, canvas.height * 0.48, canvas.height * 0.12,
      canvas.width * 0.5, canvas.height * 0.48, canvas.height * 0.78
    );
    g.addColorStop(0, "rgba(70,90,190,0.08)");
    g.addColorStop(1, "rgba(0,0,0,0.72)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function drawFlow(cameraY, wobbleX, wobbleY, pulse) {
    // Draw two glowing rails (lanes)
    const railTop = -120;
    const railBottom = canvas.height + 120;

    function rail(lane) {
      const x = laneX(lane, wobbleX);
      const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
      grad.addColorStop(0, `rgba(160,220,255,${0.10 + 0.10 * pulse})`);
      grad.addColorStop(0.5, `rgba(190,240,255,${0.22 + 0.18 * pulse})`);
      grad.addColorStop(1, `rgba(130,180,255,${0.08 + 0.08 * pulse})`);

      ctx.strokeStyle = grad;
      ctx.lineWidth = 16;
      ctx.lineCap = "round";
      ctx.beginPath();

      // Slight sinusoidal curvature for "living flow"
      const steps = 22;
      for (let i = 0; i <= steps; i++) {
        const y = railTop + (railBottom - railTop) * (i / steps);
        const worldY = cameraY + (y - canvas.height * 0.45);
        const bend = Math.sin((worldY * 0.004) + t * 2.2) * (12 + 18 * pulse);
        const px = x + bend;
        const py = y + wobbleY * 0.12;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();

      // Inner core glow
      ctx.strokeStyle = `rgba(235,252,255,${0.22 + 0.18 * pulse})`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const y = railTop + (railBottom - railTop) * (i / steps);
        const worldY = cameraY + (y - canvas.height * 0.45);
        const bend = Math.sin((worldY * 0.004) + t * 2.2) * (10 + 14 * pulse);
        const px = x + bend;
        const py = y + wobbleY * 0.12;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    rail(0);
    rail(1);
  }

  function drawGate(xLeft, xRight, y, openLane, pulse) {
    // Gate line between lanes with a bright opening indicator on safe lane
    const y0 = y;

    // Base gate bar
    ctx.strokeStyle = `rgba(233,236,255,${0.12 + 0.08 * pulse})`;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(xLeft, y0);
    ctx.lineTo(xRight, y0);
    ctx.stroke();

    // Safe side highlight
    const safeX = (openLane === 0) ? xLeft : xRight;
    ctx.strokeStyle = `rgba(160,255,220,${0.55 + 0.25 * pulse})`;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(safeX - gateHalfWidth, y0);
    ctx.lineTo(safeX + gateHalfWidth, y0);
    ctx.stroke();

    // Unsafe side hint (subtle red)
    const badX = (openLane === 0) ? xRight : xLeft;
    ctx.strokeStyle = `rgba(255,80,120,${0.18 + 0.10 * pulse})`;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(badX - gateHalfWidth, y0);
    ctx.lineTo(badX + gateHalfWidth, y0);
    ctx.stroke();
  }

  function drawHazard(x, y, pulse) {
    // A "knot" in the flow: soft red core
    const r = hazardRadius;
    const g = ctx.createRadialGradient(x, y, 2, x, y, r * 2.2);
    g.addColorStop(0, `rgba(255,90,130,${0.85})`);
    g.addColorStop(0.35, `rgba(255,60,110,${0.35 + 0.20 * pulse})`);
    g.addColorStop(1, `rgba(255,60,110,0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r * 2.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = `rgba(255,90,130,${0.75})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawBonus(x, y, pulse) {
    // Bonus ball: golden glow with shine
    const r = bonusRadius;
    const g = ctx.createRadialGradient(x, y, 2, x, y, r * 2.8);
    g.addColorStop(0, `rgba(255,250,150,${0.90})`);
    g.addColorStop(0.3, `rgba(255,230,50,${0.40 + 0.25 * pulse})`);
    g.addColorStop(1, `rgba(255,200,0,0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r * 2.8, 0, Math.PI * 2);
    ctx.fill();

    // Golden core
    ctx.fillStyle = `rgba(255,240,100,${0.85})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    // Shine spot
    ctx.fillStyle = "rgba(255,255,200,0.60)";
    ctx.beginPath();
    ctx.arc(x - r * 0.4, y - r * 0.4, r * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawPlayer(x, y, pulse, alive) {
    const r = playerRadius;
    const glow = ctx.createRadialGradient(x, y, 2, x, y, r * 4);
    if (alive) {
      glow.addColorStop(0, `rgba(200,250,255,${0.95})`);
      glow.addColorStop(0.3, `rgba(160,230,255,${0.35 + 0.25 * pulse})`);
      glow.addColorStop(1, `rgba(120,180,255,0)`);
    } else {
      glow.addColorStop(0, `rgba(255,80,120,0.95)`);
      glow.addColorStop(0.35, `rgba(255,80,120,0.25)`);
      glow.addColorStop(1, `rgba(255,80,120,0)`);
    }
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, r * 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = alive ? "rgba(235,252,255,0.95)" : "rgba(255,90,130,0.92)";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- Update & collision ---
  function update(dt) {
    if (!running) return;

    t += dt;
    milestonePulse = Math.max(0, milestonePulse - dt * 1.8);
    nearMissPopupTimer = Math.max(0, nearMissPopupTimer - dt);
    bonusChainPopupTimer = Math.max(0, bonusChainPopupTimer - dt);
    dailyChallengePopupTimer = Math.max(0, dailyChallengePopupTimer - dt);

    const prevY = player.y;
    const speed = currentSpeed();
    player.y += speed * dt;

    // Keep spawning events ahead
    while (nextEventY < player.y + 2400) spawnEvent();

    // Collision checks at "event lines"
    for (const ev of events) {
      if (ev.type === "gate" && !ev.resolved) {
        // Resolve only when the player actually crosses the gate line.
        if (prevY < ev.y && player.y >= ev.y) {
          ev.resolved = true;
          if (player.lane !== ev.openLane) {
            handleGameOver();
            break;
          } else if (!ev.scored) {
            ev.scored = true;
            gatesPassed += 1;
            score += gateScore;
            updateDailyChallenge("gates");

            const switchDelta = ev.y - lastLaneSwitchY;
            const isNearMiss =
              lastLaneSwitchTo === ev.openLane &&
              switchDelta >= 0 &&
              switchDelta <= nearMissWindow;
            if (isNearMiss) {
              score += nearMissScore;
              nearMissPopupTimer = 0.75;
              updateDailyChallenge("perfect");
            }
          }
        }
      } else if (ev.type === "hazard" && !ev.hit && !ev.passed) {
        // Resolve hazard when crossing its hit window.
        const hitBand = hazardRadius + playerRadius * 0.9;
        const enteredBand = prevY < ev.y + hitBand && player.y >= ev.y - hitBand;
        if (enteredBand) {
          if (player.lane === ev.lane) {
            ev.hit = true;
            playSfx(hazardHitSfx, 0.28);
            // Lose points but continue playing
            score = Math.max(0, score - hazardPenalty);
            bonusChain = 0;
          }
        }
        if (player.y > ev.y + hitBand) {
          ev.passed = true;
          // No points for avoiding, only penalty for hitting
        }
      } else if (ev.type === "bonus" && !ev.collected) {
        // Resolve bonus when crossing its collect window.
        const collectBand = bonusRadius + playerRadius * 1.2;
        const enteredBand = prevY < ev.y + collectBand && player.y >= ev.y - collectBand;
        if (enteredBand && player.lane === ev.lane) {
          ev.collected = true;
          playSfx(bonusCollectSfx, 0.38);
          bonusChain += 1;
          score += bonusScore;
          updateDailyChallenge("bonus");

          if (bonusChain % bonusChainStep === 0) {
            const chainTier = Math.floor(bonusChain / bonusChainStep);
            const chainReward = 8 + chainTier * 4;
            score += chainReward;
            bonusChainPopup = `BONUSKETJU x${bonusChain}  +${chainReward} p`;
            bonusChainPopupTimer = 1.1;
            milestonePulse = Math.max(milestonePulse, 0.7);
          }
        } else if (player.y > ev.y + collectBand) {
          // Bonus passed without collection, mark as collected so not checked again
          ev.collected = true;
          bonusChain = 0;
        }
      }
    }

    while (score >= nextMilestone) {
      nextMilestone += milestoneStep(nextMilestone);
      milestonePulse = 1;
    }

    scoreEl.textContent = score.toString();
  }

  function render(dt = 0.016) {
    background();

    const speed = currentSpeed();
    const bpm = bpmFromSpeed(speed);
    const beat = (t * bpm) / 60; // cycles per second
    const pulse = (Math.sin(beat * Math.PI * 2) * 0.5 + 0.5);

    // Camera: keep player around 45% height
    const cameraY = player.y;
    const targetScreenY = canvas.height * 0.45;

    // Wobble increases over time
    const p = difficultyProgress();
    const wobbleWave = 1 + Math.sin(t * 0.9) * (0.05 + 0.15 * p);
    const wobbleBase = startWobbleAmp + t * wobbleRampPerSec;
    const wobbleAmp = Math.min(maxWobbleAmp, wobbleBase * (0.85 + 0.25 * p) * wobbleWave);
    const wobbleX = Math.sin(t * (Math.PI * 2) * wobbleFreq) * wobbleAmp;
    const wobbleY = Math.cos(t * (Math.PI * 2) * wobbleFreq * 0.8) * (wobbleAmp * 0.35);

    drawDepthLayers(cameraY);
    drawFlow(cameraY, wobbleX, wobbleY, pulse);

    // Draw upcoming events (only those near camera)
    const xL = laneX(0, wobbleX);
    const xR = laneX(1, wobbleX);

    for (const ev of events) {
      const screenY = targetScreenY - (cameraY - ev.y) + wobbleY * 0.1;
      if (screenY < -200 || screenY > canvas.height + 200) continue;

      if (ev.type === "gate") {
        drawGate(xL, xR, screenY, ev.openLane, pulse);
      } else if (ev.type === "hazard") {
        const x = laneX(ev.lane, wobbleX);
        drawHazard(x, screenY, pulse);
      } else if (ev.type === "bonus") {
        const x = laneX(ev.lane, wobbleX);
        drawBonus(x, screenY, pulse);
      }
    }

    // Player always at fixed screen Y
    const px = laneX(player.lane, wobbleX);
    const py = targetScreenY + wobbleY * 0.12;

    // Smooth display x — lerps toward target lane so trail curves on lane switch
    if (displayX === null) displayX = px;
    displayX += (px - displayX) * Math.min(1, 22 * dt);

    // Record trail history (only x — y is always the same fixed screen position)
    if (!gameOver) {
      playerTrail.push(displayX);
      if (playerTrail.length > 12) playerTrail.shift();
    }

    // Draw trail oldest→newest; y offset goes upward from player
    const trailLen = playerTrail.length;
    const trailSpacing = Math.min(28, currentSpeed() * 0.030);
    for (let i = 0; i < trailLen; i++) {
      const frac = trailLen > 1 ? i / (trailLen - 1) : 1; // 0=oldest, 1=newest(closest)
      const alpha = frac * (player.alive ? 0.55 : 0.32);
      const tr = playerRadius * (0.18 + 0.70 * frac);
      const tx = playerTrail[i];
      const ty = py - (trailLen - 1 - i) * trailSpacing;  // older = further up
      const tg = ctx.createRadialGradient(tx, ty, 0, tx, ty, tr * 2.8);
      if (player.alive) {
        tg.addColorStop(0, `rgba(160,230,255,${alpha.toFixed(3)})`);
        tg.addColorStop(1, "rgba(100,160,255,0)");
      } else {
        tg.addColorStop(0, `rgba(255,90,130,${alpha.toFixed(3)})`);
        tg.addColorStop(1, "rgba(255,60,100,0)");
      }
      ctx.beginPath();
      ctx.arc(tx, ty, tr * 2.8, 0, Math.PI * 2);
      ctx.fillStyle = tg;
      ctx.fill();
    }

    drawPlayer(displayX, py, pulse, player.alive);

    if (!menuVisible && !gameOver) {
      const toTarget = Math.max(0, nextMilestone - score);
      const pulseBoost = milestonePulse * 0.35;

      ctx.textAlign = "center";
      ctx.fillStyle = `rgba(150,210,255,${0.76 + pulseBoost})`;
      ctx.font = `700 ${Math.floor(canvas.width * 0.022)}px 'Poppins', sans-serif`;
      ctx.fillText(`Portteja läpäisty ${gatesPassed}   Bonusketju ${bonusChain}`, canvas.width * 0.5, canvas.height * 0.11);

      ctx.fillStyle = `rgba(150,210,255,${0.78 + pulseBoost})`;
      ctx.font = `600 ${Math.floor(canvas.width * 0.020)}px 'Poppins', sans-serif`;
      ctx.fillText(`Seuraava tavoite ${nextMilestone} p  (${toTarget} p)`, canvas.width * 0.5, canvas.height * 0.165);

      if (bonusChainPopupTimer > 0) {
        const a = Math.min(1, bonusChainPopupTimer / 1.1);
        ctx.fillStyle = `rgba(160,230,255,${0.58 * a})`;
        ctx.fillRect(canvas.width * 0.24, canvas.height * 0.19, canvas.width * 0.52, canvas.height * 0.055);

        ctx.fillStyle = `rgba(205,245,255,${0.95 * a})`;
        ctx.font = `700 ${Math.floor(canvas.width * 0.020)}px 'Poppins', sans-serif`;
        ctx.fillText(bonusChainPopup, canvas.width * 0.5, canvas.height * 0.225);
      }

      if (nearMissPopupTimer > 0) {
        const a = Math.min(1, nearMissPopupTimer / 0.75);
        ctx.fillStyle = `rgba(150,220,255,${0.92 * a})`;
        ctx.font = `700 ${Math.floor(canvas.width * 0.021)}px 'Poppins', sans-serif`;
        ctx.fillText(`VIIME HETKEN BONUS! +${nearMissScore} p`, canvas.width * 0.5, canvas.height * 0.285);
      }

      if (dailyChallengePopupTimer > 0) {
        const a = Math.min(1, dailyChallengePopupTimer / 1.4);
        ctx.fillStyle = `rgba(170,255,220,${0.95 * a})`;
        ctx.font = `700 ${Math.floor(canvas.width * 0.022)}px 'Poppins', sans-serif`;
        ctx.fillText(dailyChallengePopup, canvas.width * 0.5, canvas.height * 0.335);
      }
    }

    // Game over overlay
    if (gameOver) {
      ctx.fillStyle = "rgba(5,6,10,0.58)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = "rgba(233,236,255,0.95)";
      ctx.textAlign = "center";
      ctx.font = `700 ${Math.floor(canvas.width * 0.045)}px 'Orbitron', 'Poppins', sans-serif`;
      ctx.fillText("Peli päättyi!", canvas.width * 0.5, canvas.height * 0.22);

      ctx.fillStyle = "rgba(190,240,255,0.92)";
      ctx.font = `700 ${Math.floor(canvas.width * 0.026)}px 'Poppins', sans-serif`;
      ctx.fillText("Top 5", canvas.width * 0.5, canvas.height * 0.38);

      ctx.fillStyle = "rgba(233,236,255,0.88)";
      ctx.font = `${Math.floor(canvas.width * 0.028)}px 'Poppins', sans-serif`;
      if (leaderboard.length === 0) {
        ctx.fillText("Ei tuloksia viela", canvas.width * 0.5, canvas.height * 0.47);
      } else {
        for (let i = 0; i < leaderboard.length; i++) {
          const lineY = canvas.height * 0.47 + i * Math.floor(canvas.height * 0.054);
          ctx.fillText(`${i + 1}. ${leaderboard[i]} p`, canvas.width * 0.5, lineY);
        }
      }

      if (latestRank !== null) {
        ctx.fillStyle = "rgba(160,220,255,0.98)";
        ctx.font = `700 ${Math.floor(canvas.width * 0.032)}px 'Poppins', sans-serif`;
        ctx.fillText(`Uusi Top 5 -tulos! Sija ${latestRank}`, canvas.width * 0.5, canvas.height * 0.88);
      }

      if (pointsToBest !== null && pointsToBest > 0) {
        ctx.fillStyle = "rgba(150,210,255,0.95)";
        ctx.font = `600 ${Math.floor(canvas.width * 0.026)}px 'Poppins', sans-serif`;
        ctx.fillText(`Ennätykseen ${pointsToBest} p`, canvas.width * 0.5, canvas.height * 0.78);
      }

      if (dailyChallenge) {
        const done = dailyChallenge.completed;
        const progress = Math.min(dailyChallenge.progress, dailyChallenge.target);
        ctx.fillStyle = done ? "rgba(170,255,220,0.96)" : "rgba(150,210,255,0.9)";
        ctx.font = `600 ${Math.floor(canvas.width * 0.017)}px 'Poppins', sans-serif`;
        ctx.fillText(`Päivän haaste: ${dailyChallenge.text}`, canvas.width * 0.5, canvas.height * 0.275);
        ctx.font = `600 ${Math.floor(canvas.width * 0.015)}px 'Poppins', sans-serif`;
        const statusLine = done
          ? `Valmis  •  Palkinto +${dailyChallengeRewardScore} p`
          : `${progress}/${dailyChallenge.target}  •  Palkinto +${dailyChallengeRewardScore} p`;
        ctx.fillText(statusLine, canvas.width * 0.5, canvas.height * 0.304);
      }
    }
  }

  function loop(ts) {
    if (!lastTs) lastTs = ts;
    const dt = Math.min(0.033, (ts - lastTs) / 1000);
    lastTs = ts;

    if (!gameOver) update(dt);
    render(dt);

    requestAnimationFrame(loop);
  }

  loadDailyChallenge();
  leaderboard = loadLeaderboard();
  initDepthLayers();
  playMainMusic();
  requestAnimationFrame(loop);
})();
