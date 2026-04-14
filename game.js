(() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d", { alpha: false });

  const scoreEl = document.getElementById("score");
  const btnRestart = document.getElementById("btnRestart");
  const btnMenu = document.getElementById("btnMenu");
  const menu = document.getElementById("menu");
  const btnStart = document.getElementById("btnStart");

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

  const startWobbleAmp = 0;
  const maxWobbleAmp = 110;
  const wobbleRampPerSec = 6.5; // how fast wobble increases
  const wobbleFreq = 0.9;       // Hz-ish

  // Timing window concept (soft): if you swap too late, you likely die at gate.
  // We implement that by making gates "decide" close to the gate line.
  const gateDecisionDistance = 120; // px before gate line where the "check" happens
  const gateScore = 10;
  const hazardScore = 6;
  const hazardPenalty = 5;  // points lost on hazard hit
  const bonusScore = 20;
  const bonusRadius = 14;
  const leaderboardKey = "valovirta_top5";
  const hazardHitSfx = "assets/boom.mp3";
  const bonusCollectSfx = "assets/booster.mp3";
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

  let t = 0;          // seconds
  let lastTs = 0;
  let score = 0;
  let leaderboard = [];
  let latestRank = null;
  let leaderboardChecked = false;
  let backgroundMusic = null;

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

  function pickRandomTrack(currentSrc = "") {
    const pool = backgroundTracks.filter((track) => !currentSrc.endsWith(track));
    return choice(pool.length > 0 ? pool : backgroundTracks);
  }

  function stopBackgroundMusic() {
    if (!backgroundMusic) return;
    backgroundMusic.pause();
    backgroundMusic.currentTime = 0;
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
    running = true; // still render
    updateLeaderboardForScore();
    stopBackgroundMusic();
  }

  function startGame() {
    menuVisible = false;
    menu.classList.add("menu-hidden");
    btnMenu.style.display = "none";
    running = true;
    reset();
    playBackgroundMusic();
  }

  function returnToMenu() {
    menuVisible = true;
    menu.classList.remove("menu-hidden");
    btnMenu.style.display = "none";
    running = false;
    gameOver = false;
    stopBackgroundMusic();
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

    player.lane = 0;
    player.y = 0;
    player.alive = true;

    events.length = 0;
    nextEventY = 700;
    scoreEl.textContent = score.toString();

    // Prime with some easy pattern
    for (let i = 0; i < 8; i++) spawnEvent();
  }

  function spawnEvent() {
    // alternate between gates and hazards, with a bit of controlled randomness
    // occasionally add a bonus ball
    let type;
    if (Math.random() < 0.12) {
      type = "bonus";
    } else if (events.length % 2 === 0) {
      type = "gate";
    } else {
      type = Math.random() < 0.55 ? "hazard" : "gate";
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

    nextEventY += rand(minSpawnDistance, maxSpawnDistance);
  }

  function toggleLane() {
    if (!running) return;
    if (gameOver) return;

    player.lane = 1 - player.lane;
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
    reset();
    if (!menuVisible) playBackgroundMusic();
  });

  // --- Rendering helpers ---
  function laneX(lane, wobbleX) {
    const cx = canvas.width * 0.5 + wobbleX;
    return cx + (lane === 0 ? -baseLaneOffset : baseLaneOffset);
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

    const speed = startSpeed + t * speedRampPerSec;
    player.y += speed * dt;

    // Keep spawning events ahead
    while (nextEventY < player.y + 2400) spawnEvent();

    // Collision checks at "event lines"
    for (const ev of events) {
      if (ev.type === "gate" && !ev.resolved) {
        // When player is close enough to gate line, resolve it
        if (player.y >= ev.y - gateDecisionDistance) {
          ev.resolved = true;
          if (player.lane !== ev.openLane) {
            handleGameOver();
            break;
          } else if (!ev.scored) {
            ev.scored = true;
            score += gateScore;
          }
        }
      } else if (ev.type === "hazard" && !ev.hit && !ev.passed) {
        // Simple distance check near hazard line (since movement is mostly along y)
        const dy = Math.abs(player.y - ev.y);
        if (dy < hazardRadius + playerRadius * 0.9) {
          if (player.lane === ev.lane) {
            ev.hit = true;
            playSfx(hazardHitSfx, 0.28);
            // Lose points but continue playing
            score = Math.max(0, score - hazardPenalty);
          }
        } else if (player.y > ev.y + hazardRadius + playerRadius * 0.9) {
          ev.passed = true;
          // No points for avoiding, only penalty for hitting
        }
      } else if (ev.type === "bonus" && !ev.collected) {
        // Check if player collects bonus
        const dy = Math.abs(player.y - ev.y);
        if (dy < bonusRadius + playerRadius * 1.2) {
          if (player.lane === ev.lane) {
            ev.collected = true;
            playSfx(bonusCollectSfx, 0.38);
            score += bonusScore;
          }
        } else if (player.y > ev.y + bonusRadius + playerRadius * 1.2) {
          // Bonus passed without collection, mark as collected so not checked again
          ev.collected = true;
        }
      }
    }

    scoreEl.textContent = score.toString();
  }

  function render() {
    background();

    const speed = startSpeed + t * speedRampPerSec;
    const bpm = bpmFromSpeed(speed);
    const beat = (t * bpm) / 60; // cycles per second
    const pulse = (Math.sin(beat * Math.PI * 2) * 0.5 + 0.5);

    // Camera: keep player around 45% height
    const cameraY = player.y;
    const targetScreenY = canvas.height * 0.45;

    // Wobble increases over time
    const wobbleAmp = Math.min(maxWobbleAmp, startWobbleAmp + t * wobbleRampPerSec);
    const wobbleX = Math.sin(t * (Math.PI * 2) * wobbleFreq) * wobbleAmp;
    const wobbleY = Math.cos(t * (Math.PI * 2) * wobbleFreq * 0.8) * (wobbleAmp * 0.35);

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
    drawPlayer(px, py, pulse, player.alive);

    // Game over overlay
    if (gameOver) {
      ctx.fillStyle = "rgba(5,6,10,0.58)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = "rgba(233,236,255,0.95)";
      ctx.textAlign = "center";
      ctx.font = `${Math.floor(canvas.width * 0.06)}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial`;
      ctx.fillText("Peli loppui", canvas.width * 0.5, canvas.height * 0.36);

      ctx.fillStyle = "rgba(233,236,255,0.75)";
      ctx.font = `${Math.floor(canvas.width * 0.038)}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial`;
      

      ctx.fillStyle = "rgba(190,240,255,0.92)";
      ctx.font = `${Math.floor(canvas.width * 0.04)}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial`;
      ctx.fillText("Top 5", canvas.width * 0.5, canvas.height * 0.50);

      ctx.fillStyle = "rgba(233,236,255,0.88)";
      ctx.font = `${Math.floor(canvas.width * 0.034)}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial`;
      if (leaderboard.length === 0) {
        ctx.fillText("Ei tuloksia viela", canvas.width * 0.5, canvas.height * 0.55);
      } else {
        for (let i = 0; i < leaderboard.length; i++) {
          const lineY = canvas.height * 0.55 + i * Math.floor(canvas.height * 0.04);
          ctx.fillText(`${i + 1}. ${leaderboard[i]} p`, canvas.width * 0.5, lineY);
        }
      }

      if (latestRank !== null) {
        ctx.fillStyle = "rgba(160,255,220,0.95)";
        ctx.font = `${Math.floor(canvas.width * 0.04)}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial`;
        ctx.fillText(`Uusi Top 5 -tulos! Sija ${latestRank}`, canvas.width * 0.5, canvas.height * 0.78);
      }
    }
  }

  function loop(ts) {
    if (!lastTs) lastTs = ts;
    const dt = Math.min(0.033, (ts - lastTs) / 1000);
    lastTs = ts;

    if (!gameOver) update(dt);
    render();

    requestAnimationFrame(loop);
  }

  leaderboard = loadLeaderboard();
  requestAnimationFrame(loop);
})();
