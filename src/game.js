import * as THREE from 'three';
import * as RAPIER from 'rapier';

// ================= 参数 =================
const CFG = {
  // 物理
  dt: 1 / 60,
  solverIterations: 8,
  gravity: { x: 0, y: -14, z: 0 },
  friction: 1.0,
  restitution: 0,
  linDamp: 0.22,
  angDamp: 0.5,
  // 场
  platformTop: 0.5,
  platformRadius: 7.5,
  aimRadius: 6.2,
  killY: -8,
  // 砖块
  widths: [0.85, 1.0, 1.15],
  heights: [0.3, 0.4],
  // 手感
  hoverDefault: 1.6,
  hoverMin: 0.25,
  hoverMax: 3.0,
  hoverStep: 0.15,
  descendSpeed: 0.85,
  slack: 0.012,
  lateralTransfer: 0.45,
  lateralClamp: 1.8,
  followRate: 11,
  // 睡眠机制（自研入睡：按“位置/姿态是否真的变了”判静，压住接触求解抖动）
  stillDrift: 0.03,    // 0.3 秒内位移小于 3cm（比求解器残余蠕动更宽松，能真正冻住）
  stillTurn: 3e-4,     // 0.3 秒内转角小于约 1.4°
  stillTime: 0.3,
  wakeRadius: 3.0,
  // 巴掌
  slapSpeed: 30,
  slapThickness: 1.7,   // 扫击板覆盖的高度范围（±0.85）
  slapImpulse: 5.5,     // 扫击给的速度增量（m/s）
  slapLift: 0.12,       // 带一点上扬，砖会翻着飞出去
  slapBiasStep: 0.4,
};

const PALETTE = [
  0xe8604c, 0xf2a03f, 0xf0c94a, 0x7cb342, 0x3ab6a5,
  0x4a90d9, 0x7a6dd0, 0xd06fa8, 0xe2ddd4, 0x8d7b6a,
];

// ================= 初始化 =================
await RAPIER.init();

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('stage').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = makeSkyTexture();
scene.fog = new THREE.Fog(0x1a1f2b, 26, 62);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 200);

// 灯光
const hemi = new THREE.HemisphereLight(0xbfd6ff, 0x39312b, 0.55);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe8cf, 1.75);
sun.position.set(9, 21, 11);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -12;
sun.shadow.camera.right = 12;
sun.shadow.camera.top = 13;
sun.shadow.camera.bottom = -13;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 70;
sun.shadow.bias = -0.0009;
sun.shadow.normalBias = 0.035;
scene.add(sun);
scene.add(sun.target);
const SUN_OFFSET = new THREE.Vector3(9, 21, 11);
const fill = new THREE.DirectionalLight(0x9fc4ff, 0.35);
fill.position.set(-8, 6, -9);
scene.add(fill);

// 台面
const platform = new THREE.Mesh(
  new THREE.CylinderGeometry(CFG.platformRadius - 0.35, CFG.platformRadius, 1.0, 72),
  new THREE.MeshStandardMaterial({ color: 0x2b303c, roughness: 0.92, metalness: 0.02 })
);
platform.position.y = 0;
platform.receiveShadow = true;
scene.add(platform);

const rim = new THREE.Mesh(
  new THREE.TorusGeometry(CFG.platformRadius, 0.055, 10, 128),
  new THREE.MeshStandardMaterial({ color: 0x6d7b91, roughness: 0.35, metalness: 0.6 })
);
rim.rotation.x = Math.PI / 2;
rim.position.y = CFG.platformTop + 0.01;
scene.add(rim);

// 台面圆环刻度
{
  const pts = [];
  for (let r = 1; r <= 6; r++) {
    const seg = 96;
    for (let i = 0; i < seg; i++) {
      const a1 = (i / seg) * Math.PI * 2, a2 = ((i + 1) / seg) * Math.PI * 2;
      pts.push(r * Math.cos(a1), 0, r * Math.sin(a1), r * Math.cos(a2), 0, r * Math.sin(a2));
    }
  }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    pts.push(0.6 * Math.cos(a), 0, 0.6 * Math.sin(a), 6 * Math.cos(a), 0, 6 * Math.sin(a));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const grid = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x7f8ea8, transparent: true, opacity: 0.22 }));
  grid.position.y = CFG.platformTop + 0.004;
  scene.add(grid);
}

// ================= 物理世界 =================
const world = new RAPIER.World(CFG.gravity);
world.timestep = CFG.dt;
world.numSolverIterations = CFG.solverIterations;
const eventQueue = new RAPIER.EventQueue(true);

const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
world.createCollider(
  RAPIER.ColliderDesc.cylinder(CFG.platformTop, CFG.platformRadius).setFriction(CFG.friction),
  groundBody
);

const blocks = [];       // { body, collider, obj, size, still, asleep }
const blockGeo = new THREE.BoxGeometry(1, 1, 1);
const edgeGeo = new THREE.EdgesGeometry(blockGeo);

function makeBlock(size, colorHex, ghost, statusColor) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: colorHex,
    roughness: ghost ? 0.5 : 0.62,
    metalness: 0.0,
    transparent: ghost,
    opacity: ghost ? 0.62 : 1,
    emissive: statusColor || 0x000000,
    emissiveIntensity: ghost ? 0.45 : 0.0,
  });
  const mesh = new THREE.Mesh(blockGeo, mat);
  mesh.castShadow = !ghost;
  mesh.receiveShadow = !ghost;
  group.add(mesh);
  const edges = new THREE.LineSegments(
    edgeGeo,
    new THREE.LineBasicMaterial({ color: ghost ? 0xffffff : 0x1a1d24, transparent: ghost, opacity: ghost ? 0.9 : 0.55 })
  );
  group.add(edges);
  group.scale.set(size[0], size[1], size[2]);
  scene.add(group);
  return { group, mesh, mat, edges };
}

// ================= 支撑面计算（用方块几何求，不依赖射线查询）=================
function quatToMat(q) {
  const { x, y, z, w } = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    [1 - (yy + zz), xy - wz, xz + wy],
    [xy + wz, 1 - (xx + zz), yz - wx],
    [xz - wy, yz + wx, 1 - (xx + yy)],
  ];
}

function syncBlockPositions() {
  for (const b of blocks) {
    b.p = b.body.translation();
    b.mat = quatToMat(b.body.rotation());
  }
}
// 某水平位置处，已有方块的顶面高度
function blockTopAt(b, x, z) {
  const m = b.mat, p = b.p;
  const hx = b.size[0] / 2, hy = b.size[1] / 2, hz = b.size[2] / 2;
  const dx = x - p.x, dy = -p.y, dz = z - p.z;
  const lx = m[0][0] * dx + m[1][0] * dy + m[2][0] * dz;
  const ly = m[0][1] * dx + m[1][1] * dy + m[2][1] * dz;
  const lz = m[0][2] * dx + m[1][2] * dy + m[2][2] * dz;
  if (Math.abs(lx) > hx || Math.abs(lz) > hz) return -Infinity;
  if (ly > hy) return -Infinity;
  return p.y + m[1][0] * lx + m[1][1] * hy + m[1][2] * lz;
}
function surfaceAt(x, z) {
  let top = CFG.platformTop;
  const r = Math.hypot(x, z);
  if (r > CFG.platformRadius) top = -Infinity;
  for (const b of blocks) {
    if (Math.abs(b.p.y - top) > 30) continue;
    const h = blockTopAt(b, x, z);
    if (h > top) top = h;
  }
  return top;
}

// 采样方块底面 3x3 网格，判断落点稳不稳
const SAMPLE_GRID = [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
function analyzeSupport(x, z, yaw, w, d) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const hs = [];
  for (const [gx, gz] of SAMPLE_GRID) {
    const ox = (gx * w) / 2, oz = (gz * d) / 2;
    hs.push(surfaceAt(x + ox * c - oz * s, z + ox * s + oz * c));
  }
  const maxH = Math.max(...hs.filter((h) => h > -Infinity), -Infinity);
  if (maxH === -Infinity) return { y: CFG.platformTop, level: 'bad', count: 0, maxH };
  let count = 0;
  for (const h of hs) if (h > maxH - 0.05) count++;
  const centerSupported = hs[4] > maxH - 0.05;
  const tilt = maxH - Math.min(...hs.filter((h) => h > maxH - 0.05));
  let level = 'bad';
  if (centerSupported) level = count >= 5 && tilt < 0.16 ? 'ok' : 'edge';
  return { y: maxH, level, count, maxH };
}

// ================= 手里的砖 =================
let held = null;
let hover = CFG.hoverDefault;
let yawStep = 0;
let camAz = 0.62;
let camEl = 0.34;
let camDist = 9;

const aim = { x: 0, z: 0, active: false };
const mouse = { x: innerWidth / 2, y: innerHeight / 2 };
const aimRay = new THREE.Raycaster();
let aimOverride = null;   // 脚本调试用：为 null 时瞄准跟随鼠标

function newHeldBlock() {
  const w = CFG.widths[(Math.random() * CFG.widths.length) | 0];
  const h = CFG.heights[(Math.random() * CFG.heights.length) | 0];
  const color = PALETTE[(Math.random() * PALETTE.length) | 0];
  held = {
    size: [w, h, w],
    color,
    yaw: 0,
    x: aim.x,
    z: aim.z,
    y: CFG.platformTop + h / 2 + hover,
    vx: 0,
    vz: 0,
    descending: false,
    restY: 1e9,
    support: null,
    obj: makeBlock([w, h, w], color, true, 0x53d769),
  };
  yawStep = 0;
  updateHeldVisual();
}

// 瞄准指示器
const hintGroup = new THREE.Group();
scene.add(hintGroup);
const footprint = new THREE.LineLoop(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]),
  new THREE.LineBasicMaterial({ color: 0x53d769, transparent: true, opacity: 0.95 })
);
const comDot = new THREE.Mesh(
  new THREE.RingGeometry(0.035, 0.075, 24),
  new THREE.MeshBasicMaterial({ color: 0x53d769, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
);
comDot.rotation.x = -Math.PI / 2;
const dropLine = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 })
);
hintGroup.add(footprint, comDot, dropLine);

// 扫击平面指示环：告诉玩家空格会从哪一层扫过去
{
  const seg = 72, pts = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * 3.4, 0, Math.sin(a) * 3.4));
  }
  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0x9fb0c6, transparent: true, opacity: 0.22 })
  );
  ring.position.y = CFG.platformTop + 0.5;
  scene.add(ring);
  window.__slapRing = ring;
}

const LEVEL_COLOR = { ok: 0x53d769, edge: 0xffc83d, bad: 0xff5a5a };

function updateHeldVisual() {
  if (!held) return;
  const [w, h, d] = held.size;
  held.obj.group.position.set(held.x, held.y, held.z);
  held.obj.group.rotation.y = held.yaw;

  const sup = analyzeSupport(held.x, held.z, held.yaw, w, d);
  held.support = sup;
  const color = LEVEL_COLOR[sup.level];
  held.obj.mat.emissive.setHex(color);

  const restY = sup.y + h / 2 + CFG.slack;
  held.restY = restY;
  if (held.y < restY) held.y = restY;

  const c = Math.cos(held.yaw), s = Math.sin(held.yaw);
  const corners = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
  const pos = footprint.geometry.attributes.position;
  corners.forEach(([ox, oz], i) => {
    pos.setXYZ(i, held.x + ox * c - oz * s, sup.y + 0.006, held.z + ox * s + oz * c);
  });
  pos.needsUpdate = true;
  footprint.geometry.computeBoundingSphere();
  footprint.material.color.setHex(color);

  comDot.position.set(held.x, sup.y + 0.012, held.z);
  comDot.material.color.setHex(color);

  const dl = dropLine.geometry.attributes.position;
  dl.setXYZ(0, held.x, sup.y + 0.01, held.z);
  dl.setXYZ(1, held.x, held.y - h / 2, held.z);
  dl.needsUpdate = true;
  dropLine.geometry.computeBoundingSphere();
  dropLine.visible = held.y - h / 2 > sup.y + 0.03;
}

// 松手：手里的砖变成真实刚体
function releaseHeld() {
  if (!held) return;
  const [w, h, d] = held.size;
  // 已经贴到支撑面再松手 = 轻轻放（不带下坠速度）；还悬在空中松手 = 砸下去
  const resting = held.y - held.restY < 0.006;
  const vDown = held.descending && !resting ? -CFG.descendSpeed : 0;
  const vx = THREE.MathUtils.clamp(held.vx * CFG.lateralTransfer, -CFG.lateralClamp, CFG.lateralClamp);
  const vz = THREE.MathUtils.clamp(held.vz * CFG.lateralTransfer, -CFG.lateralClamp, CFG.lateralClamp);

  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(held.x, held.y, held.z)
      .setRotation({ x: 0, y: Math.sin(held.yaw / 2), z: 0, w: Math.cos(held.yaw / 2) })
      .setLinearDamping(CFG.linDamp)
      .setAngularDamping(CFG.angDamp)
      .setCcdEnabled(true)
      .setLinvel(vx, vDown, vz)
  );
  const collider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2)
      .setFriction(CFG.friction)
      .setRestitution(CFG.restitution)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(24),
    body
  );
  const rec = {
    body, collider,
    obj: makeBlock([w, h, d], held.color, false, 0x000000),
    size: [w, h, d],
    still: 0, stillT: 0, asleep: false, wasAsleep: false, p0: null, q0: null,
    p: body.translation(),
    mat: quatToMat(body.rotation()),
  };
  blocks.push(rec);

  // 唤醒落点附近的砖（保底，避免睡眠层把整塔冻住不响应）
  const wakeR = Math.max(CFG.wakeRadius, Math.max(w, d) * 1.6);
  for (const b of blocks) {
    if (b === rec) continue;
    const t = b.body.translation();
    if (Math.hypot(t.x - held.x, t.z - held.z) < wakeR) b.body.wakeUp();
  }

  if (held.obj) { scene.remove(held.obj.group); disposeObj(held.obj); }
  held.obj = null;
  held = null;
  newHeldBlock();
}

function disposeObj(obj) {
  obj.mesh.material.dispose();
  obj.edges.material.dispose();
}

// ================= 巴掌 =================
let slap = null;
const shake = { power: 0, t: 0 };

function cameraBasis() {
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  fwd.y = 0;
  fwd.normalize();
  const right = new THREE.Vector3(fwd.z, 0, -fwd.x).normalize();
  return { fwd, right };
}

function makePaddle() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xf5efe6, roughness: 0.38, metalness: 0.05 });
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.32, 1.5, 2.7), mat);
  g.add(blade);
  const trailMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, depthWrite: false });
  const trail = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 2.7), trailMat);
  trail.position.x = -0.92;
  g.add(trail);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.56, 2.76), new THREE.MeshBasicMaterial({ color: 0xfff3d0 }));
  edge.position.x = 0.19;
  g.add(edge);
  return { group: g, trail };
}

// 扫击高度：默认对准塔身中部（最痛的一刀），W/S 可以上下挪，最后吸附到最近一层砖心
function slapHeight() {
  if (!blocks.length) return CFG.platformTop + 0.5;
  const topY = towerTopY();
  const mid = (CFG.platformTop + topY) / 2 + slapBias;
  const want = THREE.MathUtils.clamp(mid, CFG.platformTop + 0.25, topY - 0.05);
  let best = want, bestD = Infinity;
  for (const b of blocks) {
    const t = b.p || b.body.translation();
    const d = Math.abs(t.y - want);
    if (d < bestD) { bestD = d; best = t.y; }
  }
  return best;
}
let slapBias = 0;

function startSlap() {
  if (slap) return;
  const { right } = cameraBasis();
  const y = slapHeight();
  const paddle = makePaddle();
  const center = new THREE.Vector3(0, y, 0);
  const dir = right.clone();
  const start = center.clone().addScaledVector(dir, -CFG.platformRadius - 3.2);
  paddle.group.position.copy(start);
  // 桨面法线（局部 X）对准扫击方向
  paddle.group.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), new THREE.Vector3(dir.x, 0, dir.z));
  scene.add(paddle.group);
  slap = { dir, y, pos: -CFG.platformRadius - 3.2, paddle, hit: new Set(), t: 0 };
  sfx.whoosh();
}

function updateSlap(dt) {
  if (!slap) return;
  slap.t += dt;
  slap.pos += CFG.slapSpeed * dt;
  slap.paddle.group.position.set(slap.dir.x * slap.pos, slap.y, slap.dir.z * slap.pos);
  slap.paddle.trail.material.opacity = 0.1 + 0.1 * Math.abs(Math.sin(slap.t * 24));

  for (const b of blocks) {
    if (slap.hit.has(b)) continue;
    const t = b.body.translation();
    const along = t.x * slap.dir.x + t.z * slap.dir.z;
    if (along > slap.pos + 0.25 || along < slap.pos - 1.25) continue;
    const dy = t.y - slap.y;
    if (Math.abs(dy) > CFG.slapThickness) continue;
    slap.hit.add(b);
    const mass = b.body.mass();
    const falloff = 1 - (Math.abs(dy) / CFG.slapThickness) * 0.45;
    const dv = CFG.slapImpulse * falloff;
    // 睡眠中的刚体吃不下冲量，所以先唤醒再直接给速度增量，保证一定被扫飞
    b.body.wakeUp();
    const v = b.body.linvel();
    b.body.setLinvel({ x: v.x + slap.dir.x * dv, y: v.y + dv * CFG.slapLift, z: v.z + slap.dir.z * dv }, true);
    b.body.applyTorqueImpulse(
      { x: (Math.random() - 0.5) * mass * dv * 0.35, y: (Math.random() - 0.5) * mass * dv * 0.2, z: (Math.random() - 0.5) * mass * dv * 0.35 },
      true
    );
  }
  if (Math.abs(slap.pos) > CFG.platformRadius + 5) {
    scene.remove(slap.paddle.group);
    slap = null;
  }
}

// ================= 睡眠层 =================
// 接触点求解的微小误差会让塔慢慢累积倾斜，还会让某些砖持续高频抖动（速度不为零但位置几乎不动）。
// 所以入睡判据不看速度，看“位置和姿态有没有真的变”：0.35 秒内位移 < 6mm、转角 < 0.5° 就冻住。
// 真要倒的砖位移会迅速放大，不会被误冻；被冻住的砖在被砸到时由引擎自动唤醒。
let sleepState = 'idle';
const sleepStats = { maxLin: 0, maxAng: 0 };
function updateSleep(dt) {
  let maxLin = 0, maxAng = 0, awake = 0;
  for (const b of blocks) {
    const v = b.body.linvel(), w = b.body.angvel();
    maxLin = Math.max(maxLin, Math.hypot(v.x, v.y, v.z));
    maxAng = Math.max(maxAng, Math.hypot(w.x, w.y, w.z));
    if (b.body.isSleeping()) { b.wasAsleep = true; continue; }
    awake++;
    // 刚被唤醒（被砸到、被巴掌扫到）的砖要重新计时：高刷屏下物理步进不是每帧都走，
    // 唤醒后头几帧位移还是 0，不重置的话会在积分前被重新冻住，速度直接归零。
    if (b.wasAsleep) { b.wasAsleep = false; b.stillT = 0; b.p0 = null; continue; }
    const t = b.body.translation(), q = b.body.rotation();
    if (!b.p0) { b.p0 = { x: t.x, y: t.y, z: t.z }; b.q0 = q; b.stillT = 0; continue; }
    const dp = Math.hypot(t.x - b.p0.x, t.y - b.p0.y, t.z - b.p0.z);
    const dq = 1 - Math.abs(q.x * b.q0.x + q.y * b.q0.y + q.z * b.q0.z + q.w * b.q0.w);
    if (dp > CFG.stillDrift || dq > CFG.stillTurn) {
      b.p0 = { x: t.x, y: t.y, z: t.z }; b.q0 = q; b.stillT = 0;
      continue;
    }
    b.stillT += dt;
    if (b.stillT > CFG.stillTime) b.body.sleep();
  }
  const next = awake === 0 ? 'sleep' : maxLin > 0.35 ? 'shake' : maxLin > 0.05 || maxAng > 0.1 ? 'micro' : 'sleep';
  if (next === 'sleep' && sleepState !== 'sleep' && blocks.length > 1) sfx.chime();
  sleepState = next;
  sleepStats.maxLin = maxLin;
  sleepStats.maxAng = maxAng;
  sleepStats.awake = awake;
}

// ================= 音效（WebAudio 合成）=================
const sfx = (() => {
  let ctx = null, master = null, muted = false;
  let noiseBuf = null;
  function ensure() {
    if (ctx) return ctx;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    const len = ctx.sampleRate * 1.5;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }
  function burst({ freq, q, dur, gain, type = 'sine', sweepTo = null, noiseMix = 0 }) {
    if (!ctx || muted) return;
    const t0 = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    g.connect(master);
    if (type !== 'none') {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, t0);
      if (sweepTo) o.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.min(9000, freq * 8);
      lp.Q.value = q;
      o.connect(lp).connect(g);
      o.start(t0);
      o.stop(t0 + dur + 0.02);
    }
    if (noiseMix > 0) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq * 1.6;
      bp.Q.value = q;
      const ng = ctx.createGain();
      ng.gain.value = noiseMix;
      src.connect(bp).connect(ng).connect(g);
      src.start(t0);
      src.stop(t0 + dur + 0.02);
    }
  }
  const recent = [];
  return {
    unlock() { const c = ensure(); if (c.state === 'suspended') c.resume(); },
    toggle() { muted = !muted; if (master) master.gain.value = muted ? 0 : 0.5; return muted; },
    get muted() { return muted; },
    impact(force) {
      if (!ctx || muted) return;
      const now = performance.now();
      while (recent.length && recent[0] < now - 90) recent.shift();
      if (recent.length > 7) return;
      recent.push(now);
      const f = THREE.MathUtils.clamp(force, 20, 900);
      const hard = THREE.MathUtils.clamp((f - 20) / 500, 0, 1);
      burst({
        freq: 210 + (1 - hard) * 260,
        q: 1.2,
        dur: 0.1 + hard * 0.3,
        gain: 0.1 + hard * 0.3,
        type: 'triangle',
        sweepTo: 90,
        noiseMix: 0.25,
      });
      if (hard > 0.55) burst({ freq: 74, q: 2.5, dur: 0.5, gain: 0.32, type: 'sine', sweepTo: 44 });
    },
    whoosh() { burst({ freq: 320, q: 0.9, dur: 0.34, gain: 0.2, type: 'none', sweepTo: 1500, noiseMix: 1 }); },
    chime() { burst({ freq: 660, q: 3, dur: 0.7, gain: 0.045, type: 'sine' }); burst({ freq: 990, q: 3, dur: 0.55, gain: 0.03, type: 'sine' }); },
    clack() { burst({ freq: 900, q: 2, dur: 0.06, gain: 0.06, type: 'square', noiseMix: 0.4 }); },
  };
})();

// ================= 交互 =================
function screenToPlane(sx, sy, planeY) {
  const ndc = new THREE.Vector2((sx / innerWidth) * 2 - 1, -(sy / innerHeight) * 2 + 1);
  aimRay.setFromCamera(ndc, camera);
  const o = aimRay.ray.origin, d = aimRay.ray.direction;
  if (d.y > -1e-4) return null;
  const t = (planeY - o.y) / d.y;
  if (t <= 0) return null;
  return { x: o.x + d.x * t, z: o.z + d.z * t };
}

function updateAim() {
  if (!held) return;
  // 先在“当前塔顶”平面上求点，再用该处支撑面高度迭代一次
  const guessY = held.support ? held.support.y + hover : towerTopY();
  let p = screenToPlane(mouse.x, mouse.y, guessY);
  if (!p) return;
  p = screenToPlane(mouse.x, mouse.y, Math.max(CFG.platformTop, surfaceAt(p.x, p.z)) + hover) || p;
  const r = Math.hypot(p.x, p.z);
  if (r > CFG.aimRadius) { p.x *= CFG.aimRadius / r; p.z *= CFG.aimRadius / r; }
  aim.x = p.x;
  aim.z = p.z;
  aim.active = true;
}

function towerTopY() {
  let top = CFG.platformTop;
  for (const b of blocks) {
    const t = b.p || b.body.translation();
    top = Math.max(top, t.y + b.size[1] * 0.5);
  }
  return top;
}

renderer.domElement.addEventListener('pointermove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
let pressPointer = null;    // 只有真正按下的那一次 pointerup 才算松手
renderer.domElement.addEventListener('pointerdown', (e) => {
  sfx.unlock();
  mouse.x = e.clientX; mouse.y = e.clientY;
  if (e.button === 0) {
    if (!held) return;
    pressPointer = e.pointerId;
    held.descending = true;
    renderer.domElement.setPointerCapture?.(e.pointerId);
  } else {
    drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
  }
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.button === 0 && e.pointerId === pressPointer) {
    pressPointer = null;
    if (held && held.descending) releaseHeld();
  }
  if (drag && e.pointerId === drag.id) drag = null;
});
renderer.domElement.addEventListener('pointercancel', () => { pressPointer = null; drag = null; });
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
// 滚轮挂在 window 上：光标落在 HUD 面板上时也能调悬停高度
addEventListener('wheel', (e) => {
  e.preventDefault();
  hover = THREE.MathUtils.clamp(hover + (e.deltaY > 0 ? -CFG.hoverStep : CFG.hoverStep), CFG.hoverMin, CFG.hoverMax);
}, { passive: false });

let drag = null;
addEventListener('keydown', (e) => {
  sfx.unlock();
  if (e.code === 'Space') { e.preventDefault(); startSlap(); }
  else if (e.code === 'KeyR') resetAll();
  else if (e.code === 'KeyM') { const m = sfx.toggle(); hud.mute.textContent = m ? '静音' : '声音'; }
  else if (e.code === 'KeyQ' && held) { yawStep = (yawStep - 1) % 24; held.yaw = (yawStep * Math.PI) / 12; }
  else if (e.code === 'KeyE' && held) { yawStep = (yawStep + 1) % 24; held.yaw = (yawStep * Math.PI) / 12; }
  else if (e.code === 'KeyW') slapBias = Math.min(6, slapBias + CFG.slapBiasStep);
  else if (e.code === 'KeyS') slapBias = Math.max(-6, slapBias - CFG.slapBiasStep);
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

function resetAll() {
  for (const b of blocks) { world.removeRigidBody(b.body); scene.remove(b.obj.group); disposeObj(b.obj); }
  blocks.length = 0;
  if (held && held.obj) { scene.remove(held.obj.group); disposeObj(held.obj); }
  held = null;
  fallenOff = 0;
  peakHeight = 0; camTargetY = 2.2; camDist = 9;
  if (slap) { scene.remove(slap.paddle.group); slap = null; }
  sleepState = 'idle'; shake.power = 0;
  newHeldBlock();
}

// ================= 统计与 HUD =================
let fallenOff = 0;
let peakHeight = 0;
const hud = {
  height: document.getElementById('h-height'),
  count: document.getElementById('h-count'),
  fall: document.getElementById('h-fall'),
  state: document.getElementById('h-state'),
  stateDot: document.getElementById('h-dot'),
  best: document.getElementById('h-best'),
  mute: document.getElementById('h-mute'),
  tip: document.getElementById('h-tip'),
  hover: document.getElementById('h-hover'),
  yaw: document.getElementById('h-yaw'),
  slap: document.getElementById('h-slap'),
};
const bestKey = 'tower.best.v1';
let best = 0;
try { best = parseFloat(localStorage.getItem(bestKey) || '0') || 0; } catch { best = 0; }

const STATE_TEXT = {
  sleep: ['沉睡', '#53d769'],
  micro: ['微动', '#ffc83d'],
  shake: ['晃动', '#ff5a5a'],
  idle: ['待命', '#7f8ea8'],
};

// ================= 主循环 =================
let lastT = performance.now();
let acc = 0;
let camTargetY = 2.2;

function frame(now) {
  const dt = Math.min((now - lastT) / 1000, 0.08);
  lastT = now;

  if (held) {
    if (aimOverride) { aim.x = aimOverride.x; aim.z = aimOverride.z; } else updateAim();
    // 跟随瞄准点：带阻尼，鼠标猛动时砖会滞后，留下横向速度（手一抖就歪）
    const k = 1 - Math.exp(-CFG.followRate * dt);
    const nx = held.x + (aim.x - held.x) * k;
    const nz = held.z + (aim.z - held.z) * k;
    held.vx = (nx - held.x) / Math.max(dt, 1e-4);
    held.vz = (nz - held.z) / Math.max(dt, 1e-4);
    held.x = nx; held.z = nz;
    if (held.descending) held.y -= CFG.descendSpeed * dt;
    updateHeldVisual();
  }

  acc += dt;
  let steps = 0;
  while (acc >= CFG.dt && steps < 6) {
    world.step(eventQueue);
    acc -= CFG.dt;
    steps++;
    eventQueue.drainContactForceEvents((ev) => {
      const f = ev.totalForceMagnitude();
      if (f > 22) sfx.impact(f);
    });
  }

  updateSleep(dt);
  syncBlockPositions();

  // 同步网格 + 清理掉出台面的砖
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    const t = b.body.translation(), q = b.body.rotation();
    b.obj.group.position.set(t.x, t.y, t.z);
    b.obj.group.quaternion.set(q.x, q.y, q.z, q.w);
    if (t.y < CFG.killY) {
      world.removeRigidBody(b.body);
      scene.remove(b.obj.group);
      disposeObj(b.obj);
      blocks.splice(i, 1);
      fallenOff++;
    }
  }

  if (slap) {
    const before = slap.hit.size;
    updateSlap(dt);
    if (slap && slap.hit.size > before) {
      shake.power = Math.min(0.45, shake.power + 0.07 * (slap.hit.size - before));
      shake.t = 0;
    }
  }

  // 相机：自动取景跟随塔高
  const topY = towerTopY();
  peakHeight = Math.max(peakHeight, topY - CFG.platformTop);
  const goalY = CFG.platformTop + Math.max(0.9, peakHeight * 0.55);
  const goalDist = 7.4 + peakHeight * 0.78;
  camDist += (goalDist - camDist) * Math.min(1, dt * 1.5);
  camTargetY += (goalY - camTargetY) * Math.min(1, dt * 2.2);
  const px = Math.sin(camAz) * Math.cos(camEl) * camDist;
  const pz = Math.cos(camAz) * Math.cos(camEl) * camDist;
  const py = camTargetY + Math.sin(camEl) * camDist + 0.6;
  camera.position.set(px, py, pz);
  camera.lookAt(0, camTargetY, 0);

  // 阴影相机跟着塔中部走，保证高塔也有清晰投影
  const midY = CFG.platformTop + peakHeight * 0.5;
  sun.position.set(SUN_OFFSET.x, SUN_OFFSET.y + midY, SUN_OFFSET.z);
  sun.target.position.set(0, midY, 0);
  sun.target.updateMatrixWorld();

  if (shake.power > 0.002) {
    shake.t += dt;
    const s = shake.power * Math.exp(-shake.t * 4.5);
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.y += (Math.random() - 0.5) * s;
    camera.position.z += (Math.random() - 0.5) * s;
    shake.power *= Math.exp(-dt * 3.2);
  }

  // HUD
  hud.height.textContent = (topY - CFG.platformTop).toFixed(2);
  hud.count.textContent = String(blocks.length);
  hud.fall.textContent = String(fallenOff);
  const [st, sc] = STATE_TEXT[sleepState];
  hud.state.textContent = st;
  hubDotColor(sc);
  hud.hover.textContent = hover.toFixed(2);
  hud.yaw.textContent = `${Math.round((held ? held.yaw : 0) * 180 / Math.PI)}°`;
  hud.slap.textContent = (blocks.length ? slapHeight() : CFG.platformTop).toFixed(2);
  if (window.__slapRing) window.__slapRing.position.y = blocks.length ? slapHeight() : CFG.platformTop + 0.5;
  if (peakHeight > best) { best = peakHeight; try { localStorage.setItem(bestKey, best.toFixed(2)); } catch {} }
  hud.best.textContent = best.toFixed(2);
  hud.tip.textContent = held
    ? held.descending
      ? '松手放下'
      : sleepState === 'sleep'
        ? '塔已沉睡，按住左键缓缓放下'
        : '塔还在动，这时放下容易塌'
    : '';

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
function hubDotColor(c) { hud.stateDot.style.background = c; }

// 右键拖拽转视角
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!drag) return;
  camAz -= (e.clientX - drag.x) * 0.006;
  camEl = THREE.MathUtils.clamp(camEl + (e.clientY - drag.y) * 0.005, 0.05, 1.25);
  drag.x = e.clientX; drag.y = e.clientY;
});

function makeSkyTexture() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#0f1622');
  grad.addColorStop(0.55, '#243044');
  grad.addColorStop(1, '#4a4438');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ================= 启动 =================
document.getElementById('intro').addEventListener('click', () => {
  sfx.unlock();
  document.getElementById('intro').classList.add('gone');
  document.getElementById('start-btn')?.blur();
});
document.getElementById('h-mute').addEventListener('click', () => {
  const m = sfx.toggle();
  hud.mute.textContent = m ? '静音开' : '声音开';
});
newHeldBlock();
requestAnimationFrame(frame);
window.__towerReady = true;

// 控制台调试钩子：可以脚本化垒塔和推倒，方便调参数
window.__tower = {
  aim(x, z) {
    aimOverride = { x, z };
    aim.x = x; aim.z = z;
    if (held) { held.x = x; held.z = z; held.vx = 0; held.vz = 0; updateHeldVisual(); }
  },
  followMouse() { aimOverride = null; },
  drop() { if (held) { held.descending = true; releaseHeld(); } },   // 从当前悬停高度落下
  place() { if (held) { held.y = held.restY; releaseHeld(); } },      // 轻轻放
  slap() { startSlap(); },
  reset() { resetAll(); },
  dump() {
    return blocks.map((b, i) => {
      const t = b.body.translation(), v = b.body.linvel(), w = b.body.angvel(), q = b.body.rotation();
      const m = quatToMat(q);
      return {
        i, size: b.size,
        pos: [+t.x.toFixed(2), +t.y.toFixed(2), +t.z.toFixed(2)],
        lin: +Math.hypot(v.x, v.y, v.z).toFixed(3),
        ang: +Math.hypot(w.x, w.y, w.z).toFixed(3),
        lean: +((Math.acos(Math.min(1, Math.max(-1, m[1][1]))) * 180) / Math.PI).toFixed(1),
        sleep: b.body.isSleeping(),
      };
    });
  },
  stats() {
    let lean = 0;
    for (const b of blocks) {
      const q = b.body.rotation();
      const m = quatToMat(q);
      lean = Math.max(lean, (Math.acos(Math.min(1, Math.max(-1, m[1][1]))) * 180) / Math.PI);
    }
    return {
      blocks: blocks.length,
      top: +(towerTopY() - CFG.platformTop).toFixed(2),
      peak: +peakHeight.toFixed(2),
      fallen: fallenOff,
      sleep: sleepState,
      asleep: blocks.filter((b) => b.body.isSleeping()).length,
      lean: +lean.toFixed(1),
      maxLin: +sleepStats.maxLin.toFixed(4),
      maxAng: +sleepStats.maxAng.toFixed(4),
      slap: slap ? { pos: +slap.pos.toFixed(2), y: +slap.y.toFixed(2), hits: slap.hit.size, dir: [+slap.dir.x.toFixed(2), +slap.dir.z.toFixed(2)] } : null,
    };
  },
};
