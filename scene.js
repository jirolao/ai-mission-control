/**
 * 3D "mission control core" — a reactive WebGL scene that lives behind the HUD.
 *
 * What it shows, synced to live data each poll:
 *   - Central reactor (twin icosahedra): spins faster and glows hotter with CPU
 *     load; turns red when the system is overloaded.
 *   - Three provider rings (Claude / Codex / Gemini): each ring's bright arc
 *     fills with that provider's usage %, with a node orbiting along it.
 *   - Token particle stream: drifts inward, denser/faster when agents are busy.
 *   - Starfield + grid for depth.
 *
 * Optimized: pixel ratio capped at 1.5, frame rate capped (30 fps normally,
 * dropped to 12 fps when the machine is overloaded so the dashboard never adds
 * GPU load while you're already hot), rendering paused when the tab is hidden,
 * and a static low-energy mode under prefers-reduced-motion. Geometry and
 * materials are shared and disposed; particle count is small.
 */
import * as THREE from "./vendor/three.module.min.js";

export function initScene(canvas) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x020605, 0.018);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
  camera.position.set(0, 4, 26);

  const COL = { neon: 0x00ff9c, cyan: 0x00e5ff, claude: 0xff8a5b, codex: 0x19c2a8, gemini: 0x8a8cff, red: 0xff4d5e, amber: 0xffb454 };

  // ---- reactor core: inner solid + outer wireframe icosahedra ----
  const coreMat = new THREE.MeshStandardMaterial({ color: 0x06231a, emissive: COL.neon, emissiveIntensity: 0.5, metalness: 0.6, roughness: 0.3, flatShading: true });
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(3.2, 1), coreMat);
  const wireMat = new THREE.MeshBasicMaterial({ color: COL.neon, wireframe: true, transparent: true, opacity: 0.4 });
  const wire = new THREE.Mesh(new THREE.IcosahedronGeometry(4.1, 1), wireMat);
  scene.add(core, wire);
  const coreLight = new THREE.PointLight(COL.neon, 2.4, 60);
  scene.add(coreLight, new THREE.AmbientLight(0x0a1f17, 1.4));

  // halo sprite for fake bloom (cheap)
  const haloTex = makeHalo();
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color: COL.neon, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
  halo.scale.set(18, 18, 1);
  scene.add(halo);

  // ---- provider rings ----
  function makeRing(color, radius, tilt) {
    const group = new THREE.Group();
    const base = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.05, 8, 120), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18 }));
    const arc = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.11, 8, 120, 0.01), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }));
    const node = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 12), new THREE.MeshBasicMaterial({ color }));
    group.add(base, arc, node);
    group.rotation.x = tilt;
    scene.add(group);
    return { group, arc, node, radius, color, fill: 0, fillTarget: 0 };
  }
  const rings = {
    claude: makeRing(COL.claude, 6.5, Math.PI / 2.1),
    codex: makeRing(COL.codex, 8.2, Math.PI / 2.6),
    gemini: makeRing(COL.gemini, 9.9, Math.PI / 1.8),
  };

  // ---- token particle stream ----
  const P = 420;
  const pgeo = new THREE.BufferGeometry();
  const ppos = new Float32Array(P * 3);
  const pseed = new Float32Array(P);
  for (let i = 0; i < P; i++) resetParticle(ppos, i, true), (pseed[i] = Math.random());
  pgeo.setAttribute("position", new THREE.BufferAttribute(ppos, 3));
  const pmat = new THREE.PointsMaterial({ color: COL.cyan, size: 0.14, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
  const particles = new THREE.Points(pgeo, pmat);
  scene.add(particles);

  // ---- starfield + grid ----
  const sgeo = new THREE.BufferGeometry();
  const spos = new Float32Array(600 * 3);
  for (let i = 0; i < 600; i++) { spos[i * 3] = (Math.random() - 0.5) * 160; spos[i * 3 + 1] = (Math.random() - 0.5) * 120; spos[i * 3 + 2] = (Math.random() - 0.5) * 160; }
  sgeo.setAttribute("position", new THREE.BufferAttribute(spos, 3));
  const stars = new THREE.Points(sgeo, new THREE.PointsMaterial({ color: 0x2f6f57, size: 0.3, transparent: true, opacity: 0.6 }));
  scene.add(stars);
  const grid = new THREE.GridHelper(120, 48, 0x0d3326, 0x0a241b);
  grid.position.y = -10; scene.add(grid);

  // ---- live-synced state (smoothed) ----
  const data = { cpu: 0, cpuT: 0, alert: 0, alertT: 0, activity: 0, activityT: 0 };

  function update(s) {
    data.cpuT = (s.cpu ?? 0) / 100;
    data.alertT = s.overload ? 1 : 0;
    data.activityT = Math.max(0, Math.min(1, s.activity ?? 0));
    for (const k of ["claude", "codex", "gemini"]) rings[k].fillTarget = (s.rings && s.rings[k] != null ? s.rings[k] : 0) / 100;
  }

  // ---- render loop (throttled) ----
  let raf = 0, last = 0, t = 0, stopped = false;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (document.hidden) return;
    const fps = data.alert > 0.5 ? 12 : reduced ? 1 : 30; // ease GPU when hot
    if (now - last < 1000 / fps) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now; t += dt;

    // smooth toward targets
    data.cpu += (data.cpuT - data.cpu) * 0.08;
    data.alert += (data.alertT - data.alert) * 0.06;
    data.activity += (data.activityT - data.activity) * 0.05;
    const hot = data.alert;
    const accent = new THREE.Color(COL.neon).lerp(new THREE.Color(COL.red), hot);

    // core: spin & glow with load
    const spin = reduced ? 0 : (0.05 + data.cpu * 0.5) * dt;
    core.rotation.y += spin; core.rotation.x += spin * 0.5;
    wire.rotation.y -= spin * 0.8; wire.rotation.x += spin * 0.3;
    const pulse = 1 + Math.sin(t * (2 + data.cpu * 4)) * 0.04 * (0.4 + data.cpu);
    core.scale.setScalar(pulse);
    coreMat.emissive.copy(accent); coreMat.emissiveIntensity = 0.4 + data.cpu * 1.6;
    wireMat.color.copy(accent); wireMat.opacity = 0.3 + data.cpu * 0.4;
    coreLight.color.copy(accent); coreLight.intensity = 1.6 + data.cpu * 3;
    halo.material.color.copy(accent); halo.material.opacity = 0.4 + data.cpu * 0.3 + hot * 0.2;
    halo.scale.setScalar(16 + data.cpu * 6 + Math.sin(t * 3) * 0.6);

    // rings: fill arcs + orbit nodes
    for (const k of ["claude", "codex", "gemini"]) {
      const r = rings[k];
      r.fill += (r.fillTarget - r.fill) * 0.06;
      const theta = Math.max(0.01, r.fill * Math.PI * 2);
      r.arc.geometry.dispose();
      r.arc.geometry = new THREE.TorusGeometry(r.radius, 0.11, 8, 120, theta);
      if (!reduced) r.group.rotation.z += dt * (0.06 + r.fill * 0.25);
      const a = r.group.rotation.z + theta;
      r.node.position.set(Math.cos(a) * r.radius, Math.sin(a) * r.radius, 0);
      const warn = r.fill > 0.85;
      r.node.material.color.set(warn ? COL.red : r.color);
      r.arc.material.color.set(warn ? COL.red : r.color);
    }

    // particles drift inward; speed/opacity with activity
    const arr = pgeo.attributes.position.array;
    const speed = (0.4 + data.activity * 2.2) * dt;
    for (let i = 0; i < P; i++) {
      const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2];
      const d = Math.hypot(x, y, z) || 1;
      arr[i * 3] -= (x / d) * speed; arr[i * 3 + 1] -= (y / d) * speed; arr[i * 3 + 2] -= (z / d) * speed;
      if (d < 3.5) resetParticle(arr, i, false);
    }
    pgeo.attributes.position.needsUpdate = true;
    pmat.opacity = 0.25 + data.activity * 0.6;
    pmat.color.copy(accent);

    if (!reduced) { stars.rotation.y += dt * 0.01; camera.position.x = Math.sin(t * 0.06) * 26; camera.position.z = Math.cos(t * 0.06) * 26; camera.lookAt(0, 0, 0); }
    renderer.render(scene, camera);
  }

  function resize() {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  addEventListener("resize", resize); resize();
  raf = requestAnimationFrame(frame);
  if (reduced) renderer.render(scene, camera);

  return { update, dispose() { stopped = true; cancelAnimationFrame(raf); removeEventListener("resize", resize); renderer.dispose(); } };
}

function resetParticle(arr, i, spread) {
  const r = spread ? 8 + Math.random() * 18 : 16 + Math.random() * 8;
  const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
  arr[i * 3] = Math.sin(ph) * Math.cos(th) * r;
  arr[i * 3 + 1] = Math.sin(ph) * Math.sin(th) * r;
  arr[i * 3 + 2] = Math.cos(ph) * r;
}

function makeHalo() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,0.9)"); g.addColorStop(0.25, "rgba(255,255,255,0.35)"); g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.Texture(c); tex.needsUpdate = true; return tex;
}
