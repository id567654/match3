/* =========================================
   消消乐 (Match-3 Puzzle) — 核心游戏逻辑
   纯 Canvas 实现，零依赖，触屏+鼠标双支持
   ========================================= */

// ==================== 常量配置 ====================
const COLS = 8;                // 棋盘列数
const ROWS = 8;                // 棋盘行数
const GEM_TYPES = 6;           // 宝石种类数
const GEM_COLORS = [           // 宝石底色（清晰饱和，不晕）
  '#E85D75',  // 红
  '#F48C3C',  // 橙
  '#F2C94C',  // 黄
  '#4CAF50',  // 绿
  '#3B8EFF',  // 蓝
  '#8E5FD3',  // 紫
];

// ==================== 游戏状态 ====================
let board = [];           // board[row][col] = gem对象 或 null
let selectedRow = -1;     // 当前选中的宝石行 (-1 表示未选中)
let selectedCol = -1;
let score = 0;            // 当前分数
let level = 1;            // 当前关卡
let movesLeft = 20;       // 剩余步数
let targetScore = 500;    // 目标分数
let comboCount = 0;       // 本次操作的连击数
let totalCombos = 0;      // 总连击次数
let maxComboChain = 0;    // 最大连击链
let isProcessing = false; // 是否正在处理动画（阻止输入）
let gameOver = false;
let levelComplete = false;

// 粒子特效 & 浮动文字
let particles = [];
let floatingTexts = [];

// Canvas 相关
let canvas, ctx;
let cellSize;              // 每格像素大小
let boardLeft, boardTop;   // 棋盘左上角坐标（棋盘会内边距居中）

// 预渲染缓存（性能优化关键：把渐变/阴影提前画好，之后只贴图）
let gemCache = {};         // { type: offscreenCanvas } 每种颜色宝石预渲染一份
let boardBgCache = null;   // 棋盘背景预渲染
let needsRender = true;    // 脏标记：有动画时才重绘

// ==================== 音效系统 ====================
let audioCtx = null;
function initAudio() {
  // 需要在用户交互后调用
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch(e) { /* 不支持则静默 */ }
}
function playTone(freq, duration, type = 'sine', vol = 0.08) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + duration);
}
function sfxSelect()  { playTone(600, 0.08, 'sine', 0.05); }
function sfxSwap()     { playTone(400, 0.1, 'triangle', 0.06); }
function sfxMatch()    { playTone(800, 0.15, 'sine', 0.07);
                         setTimeout(() => playTone(1000, 0.12, 'sine', 0.05), 80); }
function sfxCombo(n)   { playTone(600 + n * 100, 0.15, 'sine', 0.07); }
function sfxNoMatch()  { playTone(200, 0.2, 'triangle', 0.05); }
function sfxLevelUp()  {
  [523, 659, 784, 1047].forEach((f, i) =>
    setTimeout(() => playTone(f, 0.25, 'sine', 0.08), i * 120));
}
function sfxGameOver() { playTone(150, 0.4, 'sawtooth', 0.05); }

// ==================== Canvas 初始化 ====================
function setupCanvas() {
  canvas = document.getElementById('gameCanvas');
  ctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', () => {
    resizeCanvas();
    updateGemPositions();
  });
}

function resizeCanvas() {
  // 根据屏幕宽度自适应棋盘大小
  const maxBoardSize = Math.min(window.innerWidth - 24, 440);
  cellSize = Math.floor(maxBoardSize / COLS);
  const boardSize = cellSize * COLS;

  // 留出边距给棋盘阴影
  boardLeft = 4;
  boardTop = 4;

  // 限制 DPR 最大 2，减少低端机 GPU 负担
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvasW = boardSize + 8;
  const canvasH = boardSize + 8;

  canvas.style.width = canvasW + 'px';
  canvas.style.height = canvasH + 'px';
  canvas.width = canvasW * dpr;
  canvas.height = canvasH * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // 尺寸变了，重建预渲染缓存
  buildGemCache();
  buildBoardBgCache();
}

// ---- 预渲染：扁平方块宝石 + 每色独特图标，避免 3D 球体头晕 ----
function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ---- 预渲染：纯色圆角方形，清晰不糊 ----
function buildGemCache() {
  gemCache = {};
  const size = cellSize;
  if (size <= 0) return;

  const margin = size * 0.08;
  const cornerR = size * 0.15;

  for (let type = 0; type < GEM_TYPES; type++) {
    const off = document.createElement('canvas');
    off.width = size;
    off.height = size;
    const oc = off.getContext('2d');
    const color = GEM_COLORS[type];

    // 纯色填充 — 无渐变，不糊
    oc.fillStyle = color;
    roundedRect(oc, margin, margin, size - margin * 2, size - margin * 2, cornerR);
    oc.fill();

    // 深色清晰描边
    const darker = darken(color, 0.2);
    oc.strokeStyle = darker;
    oc.lineWidth = Math.max(1.5, size * 0.05);
    roundedRect(oc, margin, margin, size - margin * 2, size - margin * 2, cornerR);
    oc.stroke();

    gemCache[type] = off;
  }
}

// 颜色加深工具
function darken(hex, amount) {
  const num = parseInt(hex.slice(1), 16);
  const r = Math.floor(((num >> 16) & 0xFF) * (1 - amount));
  const g = Math.floor(((num >> 8) & 0xFF) * (1 - amount));
  const b = Math.floor((num & 0xFF) * (1 - amount));
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

// ---- 预渲染：棋盘背景 ----
function buildBoardBgCache() {
  const size = cellSize * COLS;
  if (size <= 0) return;

  boardBgCache = document.createElement('canvas');
  boardBgCache.width = size + 8;
  boardBgCache.height = size + 8;
  const bc = boardBgCache.getContext('2d');

  const radius = cellSize * 0.3;
  bc.fillStyle = '#1a1a2e';
  bc.beginPath();
  bc.moveTo(4 + radius, 4);
  bc.lineTo(4 + size - radius, 4);
  bc.quadraticCurveTo(4 + size, 4, 4 + size, 4 + radius);
  bc.lineTo(4 + size, 4 + size - radius);
  bc.quadraticCurveTo(4 + size, 4 + size, 4 + size - radius, 4 + size);
  bc.lineTo(4 + radius, 4 + size);
  bc.quadraticCurveTo(4, 4 + size, 4, 4 + size - radius);
  bc.lineTo(4, 4 + radius);
  bc.quadraticCurveTo(4, 4, 4 + radius, 4);
  bc.fill();

  // 网格线
  bc.strokeStyle = 'rgba(255,255,255,0.04)';
  bc.lineWidth = 1;
  for (let r = 1; r < ROWS; r++) {
    bc.beginPath();
    bc.moveTo(4, 4 + r * cellSize);
    bc.lineTo(4 + size, 4 + r * cellSize);
    bc.stroke();
  }
  for (let c = 1; c < COLS; c++) {
    bc.beginPath();
    bc.moveTo(4 + c * cellSize, 4);
    bc.lineTo(4 + c * cellSize, 4 + size);
    bc.stroke();
  }
}

// ==================== 宝石对象 ====================
function createGem(type, row, col, startAbove) {
  const targetX = boardLeft + col * cellSize + cellSize / 2;
  const targetY = boardTop + row * cellSize + cellSize / 2;
  return {
    type: type,
    x: startAbove ? targetX - (startAbove * cellSize) : targetX,
    y: startAbove ? targetY - (startAbove * cellSize) : targetY,
    targetX: targetX,
    targetY: targetY,
    scale: 1,
    opacity: 1,
  };
}

// 更新所有宝石的目标位置（窗口大小改变后调用）
function updateGemPositions() {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (board[r] && board[r][c]) {
        board[r][c].targetX = boardLeft + c * cellSize + cellSize / 2;
        board[r][c].targetY = boardTop + r * cellSize + cellSize / 2;
        board[r][c].x = board[r][c].targetX;
        board[r][c].y = board[r][c].targetY;
      }
    }
  }
}

// ==================== 棋盘初始化 ====================
function initBoard() {
  board = [];
  for (let r = 0; r < ROWS; r++) {
    board[r] = [];
    for (let c = 0; c < COLS; c++) {
      let type;
      do {
        type = Math.floor(Math.random() * GEM_TYPES);
      } while (wouldMatchHere(r, c, type));
      board[r][c] = createGem(type, r, c, 0);
    }
  }
}

// 在 (r,c) 放 type 会不会立即形成 3 连？
function wouldMatchHere(r, c, type) {
  // 检查左边两格
  if (c >= 2) {
    const t1 = board[r][c-1] ? board[r][c-1].type : -1;
    const t2 = board[r][c-2] ? board[r][c-2].type : -1;
    if (t1 === type && t2 === type) return true;
  }
  // 检查上边两格
  if (r >= 2) {
    const t1 = board[r-1] && board[r-1][c] ? board[r-1][c].type : -1;
    const t2 = board[r-2] && board[r-2][c] ? board[r-2][c].type : -1;
    if (t1 === type && t2 === type) return true;
  }
  return false;
}

// ==================== 匹配检测 ====================
function findMatches() {
  const matched = new Set();

  // 横向：找连续 3+ 同色
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS - 2; c++) {
      if (!board[r][c] || !board[r][c+1] || !board[r][c+2]) continue;
      const t = board[r][c].type;
      if (board[r][c+1].type === t && board[r][c+2].type === t) {
        let end = c + 2;
        while (end + 1 < COLS && board[r][end+1] && board[r][end+1].type === t) end++;
        for (let i = c; i <= end; i++) matched.add(r * COLS + i);
      }
    }
  }

  // 纵向：找连续 3+ 同色
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS - 2; r++) {
      if (!board[r][c] || !board[r+1][c] || !board[r+2][c]) continue;
      const t = board[r][c].type;
      if (board[r+1][c].type === t && board[r+2][c].type === t) {
        let end = r + 2;
        while (end + 1 < ROWS && board[end+1] && board[end+1][c] && board[end+1][c].type === t) end++;
        for (let i = r; i <= end; i++) matched.add(i * COLS + c);
      }
    }
  }

  // 转换为 {row, col} 数组
  return [...matched].map(idx => ({ row: Math.floor(idx / COLS), col: idx % COLS }));
}

// ==================== 棋盘操作 ====================
function swapGems(r1, c1, r2, c2) {
  const temp = board[r1][c1];
  board[r1][c1] = board[r2][c2];
  board[r2][c2] = temp;
}

function applyGravity() {
  const moved = [];
  for (let c = 0; c < COLS; c++) {
    // 从下往上收集存在的宝石
    let writeRow = ROWS - 1;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (board[r][c]) {
        if (r !== writeRow) {
          board[writeRow][c] = board[r][c];
          board[r][c] = null;
          const gem = board[writeRow][c];
          gem.targetX = boardLeft + c * cellSize + cellSize / 2;
          gem.targetY = boardTop + writeRow * cellSize + cellSize / 2;
          moved.push(gem);
        }
        writeRow--;
      }
    }
  }
  return moved;
}

function fillEmpty() {
  const added = [];
  for (let c = 0; c < COLS; c++) {
    for (let r = ROWS - 1; r >= 0; r--) {
      if (!board[r][c]) {
        const type = Math.floor(Math.random() * GEM_TYPES);
        // 从正上方掉落（不传 startAbove，手动设置 y 偏移）
        const gem = createGem(type, r, c, 0);
        const dist = r + 2 + Math.floor(Math.random() * 4); // 从不同高度掉落，更自然
        gem.y = boardTop - dist * cellSize;
        board[r][c] = gem;
        added.push(gem);
      }
    }
  }
  return added;
}

// 检测是否还有可行操作
function hasValidMoves() {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!board[r][c]) continue;
      // 试右交换
      if (c + 1 < COLS && board[r][c+1]) {
        swapGems(r, c, r, c + 1);
        const has = findMatches().length > 0;
        swapGems(r, c, r, c + 1);
        if (has) return true;
      }
      // 试下交换
      if (r + 1 < ROWS && board[r+1][c]) {
        swapGems(r, c, r + 1, c);
        const has = findMatches().length > 0;
        swapGems(r, c, r + 1, c);
        if (has) return true;
      }
    }
  }
  return false;
}

function reshuffleBoard() {
  // 保留现有宝石类型，只打乱位置，确保无初始匹配
  const types = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (board[r][c]) types.push(board[r][c].type);
    }
  }

  // Fisher-Yates 洗牌
  for (let i = types.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [types[i], types[j]] = [types[j], types[i]];
  }

  // 重新分配，尽量避免匹配
  board = [];
  for (let r = 0; r < ROWS; r++) {
    board[r] = [];
    for (let c = 0; c < COLS; c++) {
      const idx = r * COLS + c;
      board[r][c] = createGem(types[idx], r, c, 0);
    }
  }

  // 如果有匹配，重新初始化
  if (findMatches().length > 0) {
    initBoard();
  }
}

// ==================== 动画引擎 ====================
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}
function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
function easeOutBounce(t) {
  const n1 = 7.5625, d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  else if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  else if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  else return n1 * (t -= 2.625 / d1) * t + 0.984375;
}

// 通用补间动画
function tween(duration, update, easing = easeInOut) {
  return new Promise(resolve => {
    const start = performance.now();
    function tick(now) {
      const elapsed = now - start;
      const t = Math.min(elapsed / duration, 1);
      update(easing(t));
      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        resolve();
      }
    }
    requestAnimationFrame(tick);
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 交换动画
async function animateSwap(r1, c1, r2, c2) {
  const gem1 = board[r1][c1];
  const gem2 = board[r2][c2];
  if (!gem1 || !gem2) return;

  const g1sx = gem1.x, g1sy = gem1.y;
  const g2sx = gem2.x, g2sy = gem2.y;
  // gem1 在 board[r1][c1]，但它来自 (r2,c2)，视觉位置在 (r2,c2)
  // 需要移动到目标位置 (r1,c1)
  const g1tx = boardLeft + c1 * cellSize + cellSize / 2;
  const g1ty = boardTop + r1 * cellSize + cellSize / 2;
  const g2tx = boardLeft + c2 * cellSize + cellSize / 2;
  const g2ty = boardTop + r2 * cellSize + cellSize / 2;

  await tween(180, (t) => {
    gem1.x = g1sx + (g1tx - g1sx) * t;
    gem1.y = g1sy + (g1ty - g1sy) * t;
    gem2.x = g2sx + (g2tx - g2sx) * t;
    gem2.y = g2sy + (g2ty - g2sy) * t;
  });

  // 确保到达精确位置
  gem1.targetX = g1tx; gem1.targetY = g1ty;
  gem1.x = g1tx; gem1.y = g1ty;
  gem2.targetX = g2tx; gem2.targetY = g2ty;
  gem2.x = g2tx; gem2.y = g2ty;
}

// 消除动画
async function animateRemoval(gems) {
  const duration = 280;
  const start = performance.now();

  return new Promise(resolve => {
    function tick(now) {
      const elapsed = now - start;
      const t = Math.min(elapsed / duration, 1);

      for (const gem of gems) {
        gem.scale = 1 - t;        // 缩小到 0
        gem.opacity = 1 - t;      // 淡出
      }

      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        resolve();
      }
    }
    requestAnimationFrame(tick);
  });
}

// ==================== 粒子特效 ====================
function spawnParticles(x, y, type) {
  const color = GEM_COLORS[type];
  const count = 6 + Math.floor(Math.random() * 4);
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const speed = 2 + Math.random() * 4;
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      decay: 0.02 + Math.random() * 0.03,
      size: 2 + Math.random() * 3,
      color,
    });
  }
}

function addFloatingText(x, y, text, color = '#FFF') {
  floatingTexts.push({ x, y, text, color, life: 1, vy: -2 });
}

function updateParticles() {
  for (const p of particles) {
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.1; // 重力
    p.life -= p.decay;
  }
  particles = particles.filter(p => p.life > 0);

  for (const ft of floatingTexts) {
    ft.y += ft.vy;
    ft.life -= 0.015;
  }
  floatingTexts = floatingTexts.filter(ft => ft.life > 0);
}

// ==================== 渲染（贴图版 — 避免每帧算渐变/阴影） ====================
function drawBoardBackground() {
  if (boardBgCache) {
    ctx.drawImage(boardBgCache, 0, 0);
  }
}

function drawGem(gem) {
  if (!gem || gem.opacity <= 0.01 || gem.scale <= 0.01) return;
  const cached = gemCache[gem.type];
  if (!cached) return;

  const half = cellSize / 2;
  ctx.save();
  ctx.globalAlpha = gem.opacity;
  ctx.translate(gem.x, gem.y);
  ctx.scale(gem.scale, gem.scale);
  // 贴预渲染好的宝石图（从中心对齐）
  ctx.drawImage(cached, -half, -half, cellSize, cellSize);
  ctx.restore();
}

function drawSelection() {
  if (selectedRow < 0 || selectedCol < 0) return;
  if (!board[selectedRow] || !board[selectedRow][selectedCol]) return;

  const gem = board[selectedRow][selectedCol];
  const cx = gem.x;
  const cy = gem.y;
  const half = cellSize / 2;

  // 简洁白色圆角边框 + 微弱呼吸感（极慢脉冲，不刺眼）
  const pulse = Math.sin(performance.now() / 600) * 0.06 + 1;
  const r = half + 3;

  ctx.strokeStyle = `rgba(255, 255, 255, ${0.7 + (pulse - 1) * 3})`;
  ctx.lineWidth = 3 * pulse;
  roundedRect(ctx, cx - r, cy - r, r * 2, r * 2, cellSize * 0.22);
  ctx.stroke();
}

function drawParticles() {
  for (const p of particles) {
    ctx.globalAlpha = p.life;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  for (const ft of floatingTexts) {
    ctx.globalAlpha = ft.life;
    ctx.font = `bold ${cellSize * 0.35}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 3;
    ctx.strokeText(ft.text, ft.x, ft.y);
    ctx.fillStyle = ft.color;
    ctx.fillText(ft.text, ft.x, ft.y);
  }
  ctx.globalAlpha = 1;
}

function render() {
  const w = canvas.width / (window.devicePixelRatio || 1);
  const h = canvas.height / (window.devicePixelRatio || 1);
  ctx.clearRect(0, 0, w, h);

  drawBoardBackground();

  // 绘制所有宝石
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (board[r] && board[r][c]) {
        drawGem(board[r][c]);
      }
    }
  }

  drawSelection();
  drawParticles();
}

// ==================== 游戏主循环（自适应帧率） ====================
// 活跃时 60fps，空闲时降至 4fps，避免手机持续高负载发烫
const ACTIVE_FPS = 60;
const IDLE_FPS = 4;
let lastRenderTime = 0;

function gameLoop(timestamp) {
  updateParticles();

  const isActive = isProcessing || particles.length > 0 || floatingTexts.length > 0 || selectedRow >= 0;
  const minInterval = 1000 / (isActive ? ACTIVE_FPS : IDLE_FPS);
  const elapsed = timestamp - lastRenderTime;

  if (elapsed >= minInterval) {
    render();
    lastRenderTime = timestamp;
  }

  requestAnimationFrame(gameLoop);
}

// ==================== 下落动画（重写 - 更简洁） ====================
async function animateFallingSimple(gems) {
  const uniqueGems = [...new Set(gems)];
  if (uniqueGems.length === 0) return;

  // 预计算每个宝石的动画参数（避免每帧重算导致抖动）
  const animData = [];
  for (const gem of uniqueGems) {
    const startY = gem.y;
    const targetY = gem.targetY;
    const distance = Math.abs(targetY - startY) / Math.max(cellSize, 1);
    animData.push({
      gem,
      startY,
      targetY,
      delay: Math.min(distance * 25, 120),
      duration: 350 + distance * 30,
    });
  }

  const startTime = performance.now();

  return new Promise(resolve => {
    function tick(now) {
      let allDone = true;

      for (const ad of animData) {
        const { gem, startY, targetY, delay: dl, duration: dur } = ad;
        const elapsed = Math.max(0, now - startTime - dl);
        const t = Math.min(elapsed / dur, 1);

        if (t < 1) {
          gem.y = startY + (targetY - startY) * easeOutBounce(t);
          allDone = false;
        } else {
          gem.y = targetY;
        }
      }

      if (allDone) {
        // 确保精确到位
        for (const ad of animData) {
          ad.gem.y = ad.gem.targetY;
          ad.gem.x = ad.gem.targetX;
        }
        resolve();
      } else {
        requestAnimationFrame(tick);
      }
    }
    requestAnimationFrame(tick);
  });
}

// ==================== 核心游戏流程 ====================
async function handleGemClick(row, col) {
  if (isProcessing || gameOver || levelComplete) return;
  if (!board[row] || !board[row][col]) return;

  // 首次触发时初始化音频上下文
  if (!audioCtx) initAudio();

  // 没有选中 → 选中当前
  if (selectedRow < 0 || selectedCol < 0) {
    selectedRow = row;
    selectedCol = col;
    sfxSelect();
    return;
  }

  const sr = selectedRow;
  const sc = selectedCol;

  // 点同一个 → 取消选中
  if (sr === row && sc === col) {
    selectedRow = -1;
    selectedCol = -1;
    return;
  }

  // 点不相邻的 → 切换选中
  if (Math.abs(sr - row) + Math.abs(sc - col) !== 1) {
    selectedRow = row;
    selectedCol = col;
    sfxSelect();
    return;
  }

  // === 相邻宝石：尝试交换 ===
  isProcessing = true;
  selectedRow = -1;
  selectedCol = -1;

  // 执行逻辑交换
  swapGems(sr, sc, row, col);
  sfxSwap();

  // 动画：交换
  await animateSwap(sr, sc, row, col);

  // 检查匹配
  const matches = findMatches();

  if (matches.length === 0) {
    // 没有匹配 → 换回来
    sfxNoMatch();
    swapGems(sr, sc, row, col);
    await animateSwap(row, col, sr, sc);
    isProcessing = false;
    return;
  }

  // === 有匹配：处理消除 ===
  movesLeft--;
  updateUI();

  // 消除循环（处理连锁反应）
  let chainStep = 0;
  while (true) {
    const currentMatches = findMatches();
    if (currentMatches.length === 0) break;

    chainStep++;
    const points = currentMatches.length * 10 * chainStep;
    score += points;

    // 音效
    if (chainStep === 1) sfxMatch();
    else sfxCombo(chainStep);

    // 浮动分数
    const mid = currentMatches[Math.floor(currentMatches.length / 2)];
    if (board[mid.row] && board[mid.row][mid.col]) {
      const gx = board[mid.row][mid.col].x;
      const gy = board[mid.row][mid.col].y;
      const label = chainStep > 1 ? `+${points} x${chainStep}` : `+${points}`;
      const clr = chainStep > 2 ? '#FFD700' : '#FFF';
      addFloatingText(gx, gy, label, clr);
    }

    // 粒子
    for (const m of currentMatches) {
      if (board[m.row] && board[m.row][m.col]) {
        spawnParticles(board[m.row][m.col].x, board[m.row][m.col].y, board[m.row][m.col].type);
      }
    }

    // 收集要消除的宝石引用
    const matchedGems = [];
    for (const m of currentMatches) {
      if (board[m.row] && board[m.row][m.col]) {
        matchedGems.push(board[m.row][m.col]);
      }
    }

    // 动画：消除
    await animateRemoval(matchedGems);

    // 从棋盘移除
    for (const m of currentMatches) {
      board[m.row][m.col] = null;
    }

    // 重力 + 填充
    const movedGems = applyGravity();
    const newGems = fillEmpty();

    // 动画：下落
    const allFalling = [...movedGems, ...newGems];
    if (allFalling.length > 0) {
      await animateFallingSimple(allFalling);
    }
  }

  // 连击统计
  if (chainStep > 1) {
    totalCombos++;
    if (chainStep > maxComboChain) maxComboChain = chainStep;
  }

  updateUI();
  checkGameState();
  isProcessing = false;
}

// ==================== 关卡 & 状态检测 ====================
function getLevelConfig(lv) {
  return {
    target: 300 + lv * 200,           // 300, 500, 700, 900...
    moves: 18 + Math.max(0, 6 - Math.floor(lv / 2)),  // 24, 24, 23, 23, 22...
  };
}

function startLevel(lv) {
  level = lv;
  const cfg = getLevelConfig(lv);
  targetScore = cfg.target;
  movesLeft = cfg.moves;
  score = 0;
  comboCount = 0;
  totalCombos = 0;
  maxComboChain = 0;
  gameOver = false;
  levelComplete = false;
  isProcessing = false;
  selectedRow = -1;
  selectedCol = -1;
  particles = [];
  floatingTexts = [];

  initBoard();

  // 确保有可行操作
  if (!hasValidMoves()) {
    initBoard();
  }
  updateUI();
}

function checkGameState() {
  if (score >= targetScore) {
    // 过关！
    levelComplete = true;
    sfxLevelUp();
    // 更新弹窗数据
    document.getElementById('winLevel').textContent = level;
    document.getElementById('winScore').textContent = score;
    setTimeout(() => {
      document.getElementById('winOverlay').classList.add('show');
    }, 400);
    return;
  }
  if (movesLeft <= 0) {
    // 步数用完，失败
    gameOver = true;
    sfxGameOver();
    document.getElementById('loseScore').textContent = score;
    document.getElementById('loseTarget').textContent = targetScore;
    setTimeout(() => {
      document.getElementById('loseOverlay').classList.add('show');
    }, 400);
    return;
  }
  // 检测死局
  if (!hasValidMoves()) {
    reshuffleBoard();
    addFloatingText(
      boardLeft + COLS * cellSize / 2,
      boardTop + ROWS * cellSize / 2,
      '🔀 已洗牌',
      '#FFD700'
    );
  }
}

// ==================== UI 更新 ====================
function updateUI() {
  document.getElementById('levelNum').textContent = level;
  document.getElementById('scoreNum').textContent = score;
  document.getElementById('targetNum').textContent = targetScore;
  document.getElementById('movesNum').textContent = movesLeft;

  // 步数紧张时变红
  const movesEl = document.getElementById('movesNum');
  if (movesLeft <= 5) {
    movesEl.style.color = '#FF4757';
    movesEl.style.fontWeight = 'bold';
  } else {
    movesEl.style.color = '#FFD93D';
    movesEl.style.fontWeight = 'normal';
  }
}

// ==================== 输入处理 ====================
let lastInputTime = 0;

function getCanvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  const logicalW = canvas.width / (window.devicePixelRatio || 1);
  const logicalH = canvas.height / (window.devicePixelRatio || 1);

  // pointerdown 直接用 clientX/Y；touchstart 从 touches 数组取
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;

  return {
    x: ((clientX - rect.left) / rect.width) * logicalW,
    y: ((clientY - rect.top) / rect.height) * logicalH,
  };
}

function getGemAtPos(pos) {
  const col = Math.floor((pos.x - boardLeft) / cellSize);
  const row = Math.floor((pos.y - boardTop) / cellSize);
  if (row >= 0 && row < ROWS && col >= 0 && col < COLS) {
    return { row, col };
  }
  return null;
}

function onCanvasDown(e) {
  e.preventDefault();
  // 防连点：同一帧内忽略重复事件（pointerdown + touchstart 可能同时触发）
  const now = Date.now();
  if (now - lastInputTime < 150) return;
  lastInputTime = now;

  const pos = getCanvasPos(e);
  const gem = getGemAtPos(pos);
  if (gem) {
    handleGemClick(gem.row, gem.col);
  }
}

// ==================== 按钮事件 ====================
function restartGame() {
  document.getElementById('winOverlay').classList.remove('show');
  document.getElementById('loseOverlay').classList.remove('show');
  startLevel(1);
}

function nextLevel() {
  document.getElementById('winOverlay').classList.remove('show');
  startLevel(level + 1);
}

function shuffleBoard() {
  if (isProcessing || gameOver || levelComplete) return;
  selectedRow = -1;
  selectedCol = -1;
  reshuffleBoard();
  // 洗牌也消耗一步（防止滥用）
  // movesLeft = Math.max(0, movesLeft - 1);
  updateUI();
}

// ==================== 启动 ====================
function init() {
  setupCanvas();
  initAudio();

  // 事件监听：pointerdown 统一处理鼠标+触屏，无 300ms 延迟
  // 老旧浏览器降级用 touchstart
  if (window.PointerEvent) {
    canvas.addEventListener('pointerdown', onCanvasDown);
  } else {
    canvas.addEventListener('mousedown', onCanvasDown);
    canvas.addEventListener('touchstart', onCanvasDown, { passive: false });
  }
  // 阻止移动端长按菜单 & 拖拽选中的奇怪行为
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('selectstart', e => e.preventDefault());

  // 按钮绑定
  document.getElementById('btnRestart').addEventListener('click', restartGame);
  document.getElementById('btnShuffle').addEventListener('click', shuffleBoard);
  document.getElementById('btnNextLevel').addEventListener('click', nextLevel);
  document.getElementById('btnRetry').addEventListener('click', restartGame);
  // 过关弹窗里的重新开始按钮
  const btnRestartWin = document.getElementById('btnRestartFromWin');
  if (btnRestartWin) {
    btnRestartWin.addEventListener('click', () => {
      document.getElementById('winOverlay').classList.remove('show');
      startLevel(1);
    });
  }

  // 注册 Service Worker (PWA 离线缓存)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // 开始第一关
  startLevel(1);

  // 启动游戏循环
  requestAnimationFrame(gameLoop);
}

window.addEventListener('DOMContentLoaded', init);
