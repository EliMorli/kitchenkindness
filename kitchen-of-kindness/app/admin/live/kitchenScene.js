// Kitchen Live 3D diorama (three.js). A plain module with no React: the page
// creates it in an effect and drives it with setModel / setStage / select.
//
// Layout (world units, y up), a round "island" seen at an isometric angle:
//   - the kitchen building at the back of the center lot, printer on its
//     right, pickup rack on its left;
//   - one bag pile per delivery group in front of the kitchen;
//   - a ring road; one van per group waits on the inner lane;
//   - houses around the outer edge, one per van.
// Stages: 0 cooking (ghost bags), 1 packing (labeled bags), 2 delivering
// (bags in vans, vans parked at their houses), 3 delivered.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const TAU = Math.PI * 2;
const LOT_R = 4.4;
const ROAD_IN = 4.62;
const ROAD_OUT = 5.8;
const LOAD_R = 4.93;
const DRIVE_R = 5.5;
const PARK_R = 6.2;
const HOUSE_R = 7.1;
const BASE_R = 8.6;
const HOME_TARGET = new THREE.Vector3(0, 0.4, 0);
const KITCHEN_POS = new THREE.Vector3(0, 0, -2.05);
const PRINTER_POS = new THREE.Vector3(2.3, 0, -0.5);
const RACK_POS = new THREE.Vector3(-2.35, 0, -0.45);
const PILES_Z = 1.75;
// Bags are drawn a bit oversized so the piles still read on a phone.
const BAG = 1.3;
// Group numbers over the piles show once the view is zoomed in this far.
const PIN_ZOOM = 1.35;

const ease = {
  linear: t => t,
  inOut: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  out: t => 1 - Math.pow(1 - t, 3),
  in: t => t * t * t,
  back: t => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }
};

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => t * t * (3 - 2 * t);
// Rotation about y that points an object's local +x along (dx, dz).
const yawFor = (dx, dz) => Math.atan2(-dz, dx);

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function roundedRectShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function canvasTexture(width, height, draw) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  draw(c.getContext('2d'), width, height);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function createKitchenScene(container, { onSelect, reducedMotion = false } = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (e) {
    throw new Error('webgl-unavailable');
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.className = 'kl-canvas';
  container.appendChild(canvas);
  const overlay = document.createElement('div');
  overlay.className = 'kl-pins';
  container.appendChild(overlay);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
  camera.position
    .setFromSpherical(new THREE.Spherical(40, THREE.MathUtils.degToRad(55), THREE.MathUtils.degToRad(45)))
    .add(HOME_TARGET);
  camera.lookAt(HOME_TARGET);

  const disposables = [];
  const track = x => {
    disposables.push(x);
    return x;
  };
  const matCache = new Map();
  const std = (color, extra = {}) => {
    const key = color + JSON.stringify(extra);
    if (!matCache.has(key)) {
      matCache.set(key, track(new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.02, ...extra })));
    }
    return matCache.get(key);
  };
  const mesh = (geo, material, { x = 0, y = 0, z = 0, cast = false, receive = false } = {}) => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.castShadow = cast;
    m.receiveShadow = receive;
    return m;
  };

  // ---------- lights ----------
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd5deea, 1.9));
  const sun = new THREE.DirectionalLight(0xffffff, 2.3);
  sun.position.set(7, 15, 9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 45 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);

  // ---------- shared geometry ----------
  const G = {
    bagBody: track(new THREE.BoxGeometry(0.26, 0.3, 0.18)),
    bagFold: track(new THREE.BoxGeometry(0.27, 0.05, 0.19)),
    bagLabel: track(new THREE.PlaneGeometry(0.17, 0.1)),
    satBand: track(new THREE.BoxGeometry(0.272, 0.04, 0.192)),
    giftBody: track(new THREE.BoxGeometry(0.24, 0.2, 0.24)),
    giftRibbonA: track(new THREE.BoxGeometry(0.246, 0.206, 0.05)),
    giftRibbonB: track(new THREE.BoxGeometry(0.05, 0.206, 0.246)),
    giftBow: track(new THREE.SphereGeometry(0.05, 10, 8)),
    vanCargo: track(new RoundedBoxGeometry(0.8, 0.5, 0.48, 2, 0.06)),
    vanCab: track(new RoundedBoxGeometry(0.36, 0.4, 0.46, 2, 0.06)),
    vanGlassFront: track(new THREE.BoxGeometry(0.03, 0.17, 0.38)),
    vanGlassSide: track(new THREE.BoxGeometry(0.2, 0.14, 0.47)),
    vanStripe: track(new THREE.BoxGeometry(0.82, 0.09, 0.49)),
    vanChassis: track(new THREE.BoxGeometry(1.12, 0.1, 0.4)),
    wheel: track(new THREE.CylinderGeometry(0.1, 0.1, 0.07, 14).rotateX(Math.PI / 2)),
    houseBody: track(new THREE.BoxGeometry(0.9, 0.62, 0.8)),
    houseRoof: track(new THREE.ConeGeometry(0.72, 0.44, 4).rotateY(Math.PI / 4)),
    houseDoor: track(new THREE.BoxGeometry(0.2, 0.32, 0.02)),
    houseWindow: track(new THREE.BoxGeometry(0.2, 0.16, 0.02)),
    trunk: track(new THREE.CylinderGeometry(0.045, 0.065, 0.32, 6)),
    pine: track(new THREE.ConeGeometry(0.3, 0.75, 7)),
    round: track(new THREE.IcosahedronGeometry(0.32, 1)),
    confetti: track(new THREE.BoxGeometry(0.08, 0.08, 0.016)),
    smoke: track(new THREE.IcosahedronGeometry(1, 1)),
    flyLabel: track(new THREE.BoxGeometry(0.17, 0.014, 0.1))
  };

  // A small folded-paper airplane, nose along +z (Object3D.lookAt points +z).
  const planeGeo = track(new THREE.BufferGeometry());
  planeGeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        0, 0, 0.36, -0.24, 0, -0.26, 0, 0.02, -0.16,
        0, 0, 0.36, 0, 0.02, -0.16, 0.24, 0, -0.26,
        0, 0, 0.36, 0, 0.02, -0.16, 0, -0.08, -0.2
      ],
      3
    )
  );
  planeGeo.computeVertexNormals();
  // Dotted trail behind the plane, fading out toward the tail.
  const trailGeo = track(new THREE.SphereGeometry(0.06, 8, 6));
  const trail = Array.from({ length: 14 }, (_, k) =>
    mesh(
      trailGeo,
      track(new THREE.MeshBasicMaterial({ color: '#25d366', transparent: true, opacity: 0.75 * (1 - k / 14), depthWrite: false }))
    )
  );

  // ---------- static world ----------
  const world = new THREE.Group();
  scene.add(world);
  const fx = new THREE.Group();
  scene.add(fx);

  const shadowTex = track(
    canvasTexture(256, 256, (x, w, h) => {
      const g = x.createRadialGradient(w / 2, h / 2, w * 0.18, w / 2, h / 2, w / 2);
      g.addColorStop(0, 'rgba(15,23,42,0.22)');
      g.addColorStop(1, 'rgba(15,23,42,0)');
      x.fillStyle = g;
      x.fillRect(0, 0, w, h);
    })
  );
  world.add(
    mesh(
      track(new THREE.PlaneGeometry(BASE_R * 2.7, BASE_R * 2.7).rotateX(-Math.PI / 2)),
      track(new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })),
      { y: -0.85 }
    )
  );
  world.add(mesh(track(new THREE.CylinderGeometry(BASE_R, BASE_R - 0.3, 0.75, 96)), std('#e7edf5'), { y: -0.375, receive: true }));
  const disc = (r0, r1, color, y) => {
    const g = track(r0 > 0 ? new THREE.RingGeometry(r0, r1, 120) : new THREE.CircleGeometry(r1, 120));
    g.rotateX(-Math.PI / 2);
    return mesh(g, std(color), { y, receive: true });
  };
  world.add(disc(ROAD_OUT, BASE_R - 0.02, '#dcf1e3', 0.002));
  world.add(disc(0, LOT_R, '#f8fafc', 0.004));
  world.add(disc(LOT_R, ROAD_IN, '#e2e8f0', 0.003));
  world.add(disc(ROAD_IN, ROAD_OUT, '#c7d1dd', 0.005));
  const dashGeo = track(new THREE.BoxGeometry(0.34, 0.01, 0.06));
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * TAU;
    const r = (ROAD_IN + ROAD_OUT) / 2;
    const d = mesh(dashGeo, std('#f8fafc'), { x: Math.cos(a) * r, y: 0.012, z: Math.sin(a) * r });
    d.rotation.y = yawFor(-Math.sin(a), Math.cos(a));
    world.add(d);
  }

  // Kitchen building.
  const kitchen = new THREE.Group();
  kitchen.position.copy(KITCHEN_POS);
  kitchen.userData.sel = { type: 'kitchen' };
  kitchen.add(mesh(track(new RoundedBoxGeometry(3.4, 1.55, 2.2, 3, 0.08)), std('#ffffff'), { y: 0.775, cast: true, receive: true }));
  kitchen.add(mesh(track(new THREE.BoxGeometry(3.7, 0.18, 2.5)), std('#0e7490'), { y: 1.62, cast: true }));
  const ridgeGeo = track(new THREE.BoxGeometry(3.7, 0.07, 0.12));
  for (let i = 0; i < 6; i++) kitchen.add(mesh(ridgeGeo, std('#0891b2'), { y: 1.74, z: -1.0 + i * 0.4 }));
  kitchen.add(mesh(track(new THREE.BoxGeometry(0.62, 0.95, 0.04)), std('#334155'), { y: 0.475, z: 1.11 }));
  kitchen.add(mesh(track(new THREE.BoxGeometry(1.0, 0.06, 0.42)), std('#f97316'), { y: 1.0, z: 1.3, cast: true }));
  const winMat = track(new THREE.MeshStandardMaterial({ color: '#bae6fd', emissive: '#7dd3fc', emissiveIntensity: 0.55, roughness: 0.4 }));
  const winGeo = track(new THREE.BoxGeometry(0.55, 0.42, 0.04));
  [-1.05, 1.05].forEach(x => kitchen.add(mesh(winGeo, winMat, { x, y: 0.82, z: 1.11 })));
  const winSideGeo = track(new THREE.BoxGeometry(0.04, 0.42, 0.55));
  [-0.5, 0.5].forEach(z => kitchen.add(mesh(winSideGeo, winMat, { x: 1.71, y: 0.82, z })));
  const signTex = track(
    canvasTexture(640, 104, (x, w, h) => {
      x.fillStyle = '#ffffff';
      x.beginPath();
      x.roundRect(4, 4, w - 8, h - 8, 26);
      x.fill();
      x.fillStyle = '#ea580c';
      x.font = '800 52px system-ui, -apple-system, "Segoe UI", sans-serif';
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillText('Kitchen of Kindness', w / 2, h / 2 + 3);
    })
  );
  kitchen.add(
    mesh(track(new THREE.PlaneGeometry(2.3, 0.37)), track(new THREE.MeshBasicMaterial({ map: signTex, transparent: true })), {
      y: 1.33,
      z: 1.115
    })
  );
  kitchen.add(mesh(track(new THREE.CylinderGeometry(0.16, 0.19, 0.75, 12)), std('#94a3b8'), { x: -1.05, y: 2.05, z: -0.5, cast: true }));
  world.add(kitchen);
  const chimneyTop = new THREE.Vector3(KITCHEN_POS.x - 1.05, 2.45, KITCHEN_POS.z - 0.5);

  // Label printer on a little table.
  const printer = new THREE.Group();
  printer.position.copy(PRINTER_POS);
  printer.userData.sel = { type: 'printer' };
  const woodMat = std('#e7d3b5');
  printer.add(mesh(track(new THREE.BoxGeometry(0.7, 0.42, 0.5)), woodMat, { y: 0.21, cast: true, receive: true }));
  printer.add(mesh(track(new RoundedBoxGeometry(0.44, 0.2, 0.36, 2, 0.04)), std('#1e293b'), { y: 0.52, cast: true }));
  printer.add(mesh(track(new THREE.BoxGeometry(0.26, 0.012, 0.12)), std('#ffffff'), { y: 0.626, z: 0.06 }));
  const ledMat = track(new THREE.MeshStandardMaterial({ color: '#22c55e', emissive: '#22c55e', emissiveIntensity: 0.3 }));
  printer.add(mesh(track(new THREE.SphereGeometry(0.03, 10, 8)), ledMat, { x: 0.16, y: 0.6, z: 0.17 }));
  world.add(printer);
  const printerOut = PRINTER_POS.clone().add(new THREE.Vector3(0, 0.68, 0.1));

  // Pickup rack: two shelves, bags for families who collect at the kitchen.
  const rack = new THREE.Group();
  rack.position.copy(RACK_POS);
  rack.userData.sel = { type: 'pickup' };
  [0.32, 0.7].forEach(y => rack.add(mesh(track(new THREE.BoxGeometry(1.9, 0.05, 0.6)), woodMat, { y, cast: true, receive: true })));
  const postGeo = track(new THREE.BoxGeometry(0.05, 0.72, 0.05));
  [[-0.92, -0.27], [0.92, -0.27], [-0.92, 0.27], [0.92, 0.27]].forEach(([x, z]) =>
    rack.add(mesh(postGeo, woodMat, { x, y: 0.36, z, cast: true }))
  );
  world.add(rack);

  // Trees on the outer rim and a few behind the kitchen.
  const rng = seeded(11);
  const treeMats = [std('#4ade80'), std('#22c55e'), std('#86efac')];
  const addTree = (x, z, s) => {
    const t = new THREE.Group();
    t.position.set(x, 0, z);
    t.scale.setScalar(s);
    t.add(mesh(G.trunk, std('#a16207'), { y: 0.16, cast: true }));
    const pine = rng() < 0.5;
    t.add(mesh(pine ? G.pine : G.round, treeMats[Math.floor(rng() * 3)], { y: pine ? 0.62 : 0.55, cast: true }));
    world.add(t);
  };
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU + rng() * 0.1;
    const r = BASE_R - 0.75 + rng() * 0.3;
    addTree(Math.cos(a) * r, Math.sin(a) * r, 0.65 + rng() * 0.35);
  }
  [[-2.6, -3.15], [2.6, -3.15], [-3.55, -2.05], [3.55, -2.05]].forEach(([x, z]) => addTree(x, z, 0.7 + rng() * 0.25));

  // Chimney smoke (busy while cooking and packing).
  const smoke = [];
  for (let i = 0; i < 12; i++) {
    const m = track(new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false, roughness: 1 }));
    const p = mesh(G.smoke, m);
    p.userData.phase = i / 12;
    world.add(p);
    smoke.push(p);
  }
  let smokeLevel = 1;
  let smokeTarget = 1;

  // Selection ring under the selected group.
  const ringMat = track(new THREE.MeshBasicMaterial({ color: '#0891b2', transparent: true, opacity: 0.9, depthWrite: false }));
  const ring = mesh(track(new THREE.RingGeometry(0.62, 0.76, 48).rotateX(-Math.PI / 2)), ringMat);
  ring.visible = false;
  world.add(ring);

  // ---------- pins (DOM labels that follow 3D points) ----------
  const pins = [];
  const tmp = new THREE.Vector3();
  function addPin({ text, color, cls = '', sel, pos, visible, dynamic = false }) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `kl-pin ${cls}`;
    el.textContent = text;
    if (color) el.style.setProperty('--pin', color);
    el.addEventListener('click', e => {
      e.stopPropagation();
      onSelect?.(sel);
    });
    overlay.appendChild(el);
    const pin = { el, pos, visible, dynamic };
    pins.push(pin);
    return pin;
  }
  function clearDynamicPins() {
    for (let i = pins.length - 1; i >= 0; i--) {
      if (pins[i].dynamic) {
        pins[i].el.remove();
        pins.splice(i, 1);
      }
    }
  }
  let viewW = 1;
  let viewH = 1;
  function updatePins() {
    for (const p of pins) {
      if (!p.visible()) {
        if (p.el.style.display !== 'none') p.el.style.display = 'none';
        continue;
      }
      tmp.copy(p.pos()).project(camera);
      const x = (tmp.x * 0.5 + 0.5) * viewW;
      const y = (-tmp.y * 0.5 + 0.5) * viewH;
      if (x < -40 || x > viewW + 40 || y < -10 || y > viewH + 40) {
        p.el.style.display = 'none';
        continue;
      }
      p.el.style.display = '';
      p.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    }
  }

  let stage = 0;
  let meals = 0;
  let bagsTotal = 0;
  let pickupCount = 0;
  const kitchenPin = addPin({
    text: '',
    cls: 'light',
    sel: { type: 'kitchen' },
    pos: () => tmp.set(KITCHEN_POS.x, 2.55, KITCHEN_POS.z),
    visible: () => true
  });
  const printerPin = addPin({
    text: '',
    cls: 'light',
    sel: { type: 'printer' },
    pos: () => tmp.set(PRINTER_POS.x, 1.0, PRINTER_POS.z),
    visible: () => stage >= 1 && bagsTotal > 0 && (camera.zoom >= PIN_ZOOM || selected?.type === 'printer')
  });
  const pickupPin = addPin({
    text: '',
    color: '#57534e',
    sel: { type: 'pickup' },
    pos: () => tmp.set(RACK_POS.x, 1.15, RACK_POS.z),
    visible: () => pickupCount > 0 && stage <= 2
  });

  // ---------- dynamic model: bags, vans, houses ----------
  let dyn = new THREE.Group();
  world.add(dyn);
  let dynDisposables = [];
  let clusters = [];
  let allBags = [];
  let cellSize = 1.35;
  const ghostMat = track(new THREE.MeshBasicMaterial({ color: '#94a3b8', transparent: true, opacity: 0.32, depthWrite: false }));

  function makeBag(type, color) {
    const g = new THREE.Group();
    const parts = [];
    let label = null;
    const add = m => {
      g.add(m);
      parts.push({ mesh: m, mat: m.material });
    };
    if (type === 'box') {
      add(mesh(G.giftBody, std('#fff7ed'), { y: 0.1 }));
      add(mesh(G.giftRibbonA, std('#e11d48'), { y: 0.1 }));
      add(mesh(G.giftRibbonB, std('#e11d48'), { y: 0.1 }));
      add(mesh(G.giftBow, std('#e11d48'), { y: 0.215 }));
    } else {
      add(mesh(G.bagBody, std(type === 'sat' ? '#c9935f' : '#dcae7e'), { y: 0.15 }));
      add(mesh(G.bagFold, std('#b98552'), { y: 0.315 }));
      if (type === 'sat') add(mesh(G.satBand, std('#1d4ed8'), { y: 0.25 }));
      label = mesh(G.bagLabel, std(color, { roughness: 0.55 }), { y: 0.14, z: 0.0905 });
      g.add(label);
    }
    return { obj: g, parts, label, type, labelColor: color, home: new THREE.Vector3(), baseScale: 1, pickup: false };
  }
  function setGhost(bag, ghost) {
    for (const p of bag.parts) p.mesh.material = ghost ? ghostMat : p.mat;
    if (bag.label) bag.label.visible = !ghost;
  }

  function makeVan(color) {
    const g = new THREE.Group();
    const white = std('#ffffff');
    const glass = std('#1e3a5f', { roughness: 0.3 });
    g.add(mesh(G.vanChassis, std('#334155'), { y: 0.17 }));
    g.add(mesh(G.vanCargo, white, { x: -0.13, y: 0.45, cast: true }));
    g.add(mesh(G.vanCab, white, { x: 0.46, y: 0.4, cast: true }));
    g.add(mesh(G.vanGlassFront, glass, { x: 0.635, y: 0.47 }));
    g.add(mesh(G.vanGlassSide, glass, { x: 0.47, y: 0.49 }));
    g.add(mesh(G.vanStripe, std(color), { x: -0.13, y: 0.42 }));
    const wheels = [[0.36, 0.22], [0.36, -0.22], [-0.34, 0.22], [-0.34, -0.22]].map(([x, z]) => {
      const w = mesh(G.wheel, std('#1f2937'), { x, y: 0.1, z });
      g.add(w);
      return w;
    });
    return { obj: g, wheels };
  }

  const HOUSE_COLORS = ['#fde68a', '#bfdbfe', '#fecaca', '#bbf7d0', '#ddd6fe', '#fed7aa', '#a5f3fc', '#fbcfe8'];
  const ROOF_COLORS = ['#b45309', '#1d4ed8', '#b91c1c', '#15803d', '#6d28d9', '#c2410c', '#0e7490', '#be185d'];
  function makeHouse(i) {
    const g = new THREE.Group();
    g.add(mesh(G.houseBody, std(HOUSE_COLORS[i % 8]), { y: 0.31, cast: true, receive: true }));
    g.add(mesh(G.houseRoof, std(ROOF_COLORS[i % 8]), { y: 0.84, cast: true }));
    g.add(mesh(G.houseDoor, std('#7c2d12'), { x: 0.18, y: 0.16, z: 0.41 }));
    g.add(mesh(G.houseWindow, std('#e0f2fe'), { x: -0.18, y: 0.38, z: 0.41 }));
    return g;
  }

  const ringPos = (r, a) => new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
  // Counterclockwise tangent heading at angle a.
  const tangentYaw = a => yawFor(-Math.sin(a), Math.cos(a));

  function setModel(model, stageNow = 0) {
    cancelAll();
    world.remove(dyn);
    dynDisposables.forEach(d => d.dispose());
    dynDisposables = [];
    dyn = new THREE.Group();
    world.add(dyn);
    clearDynamicPins();
    clusters = [];
    allBags = [];

    meals = model.meals || 0;
    bagsTotal = model.bagsTotal || 0;
    const list = model.clusters || [];
    const n = list.length;
    const cols = n <= 4 ? Math.max(n, 1) : n <= 12 ? 4 : 5;
    const rows = Math.max(1, Math.ceil(n / cols));
    cellSize = Math.min(1.2, 3.5 / rows, 5.0 / cols);
    const decalGeo = new THREE.ShapeGeometry(roundedRectShape(cellSize - 0.12, cellSize - 0.12, 0.16));
    decalGeo.rotateX(-Math.PI / 2);
    dynDisposables.push(decalGeo);

    list.forEach((c, i) => {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const inRow = row === rows - 1 ? n - row * cols : cols;
      const cx = (col - (inRow - 1) / 2) * cellSize;
      const cz = PILES_Z + (row - (rows - 1) / 2) * cellSize;
      const sel = { type: 'group', key: c.key };
      const decalMat = new THREE.MeshBasicMaterial({ color: c.color, transparent: true, opacity: 0.2, depthWrite: false });
      dynDisposables.push(decalMat);
      const decal = mesh(decalGeo, decalMat, { x: cx, y: 0.008, z: cz });
      decal.userData.sel = sel;
      dyn.add(decal);

      // Big piles (Thursday bags, holiday boxes) stack two high.
      const m = c.bags.length;
      const layers = m > 6 ? 2 : 1;
      const perLayer = Math.ceil(m / layers);
      const gcols = Math.max(1, Math.ceil(Math.sqrt(perLayer)));
      const grows = Math.ceil(perLayer / gcols);
      const spacing = Math.min(0.46, (cellSize - 0.3) / gcols);
      const scale = BAG * Math.min(1, spacing / 0.46);
      const bags = c.bags.map((b, j) => {
        const bag = makeBag(b.type, c.color);
        const layer = Math.floor(j / perLayer);
        const k = j % perLayer;
        bag.home.set(
          cx + ((k % gcols) - (gcols - 1) / 2) * spacing + layer * spacing * 0.22,
          0.01 + layer * (b.type === 'box' ? 0.26 : 0.36) * scale,
          cz + (Math.floor(k / gcols) - (grows - 1) / 2) * spacing + layer * spacing * 0.12
        );
        bag.baseScale = scale;
        bag.obj.userData.sel = sel;
        dyn.add(bag.obj);
        allBags.push(bag);
        return bag;
      });
      clusters.push({ key: c.key, label: c.label, color: c.color, center: new THREE.Vector3(cx, 0, cz), bags });
    });

    // Vans wait on the inner lane across the front; houses ring the edge.
    const V = clusters.length;
    const H = Math.max(V, 6);
    const houseAngles = Array.from({ length: H }, (_, i) => Math.PI / 2 + ((i + 1) * TAU) / (H + 1));
    houseAngles.forEach((a, i) => {
      const house = makeHouse(i);
      house.position.copy(ringPos(HOUSE_R, a));
      house.rotation.y = Math.atan2(-Math.cos(a), -Math.sin(a));
      dyn.add(house);
      if (i < V) house.userData.sel = { type: 'group', key: clusters[i].key };
    });
    const step = Math.min(0.26, 3.1 / Math.max(V, 1));
    let maxTravel = 0;
    clusters.forEach((c, k) => {
      const van = makeVan(c.color);
      van.obj.userData.sel = { type: 'group', key: c.key };
      dyn.add(van.obj);
      const a0 = Math.PI / 2 + (k - (V - 1) / 2) * step;
      const aH = houseAngles[k];
      let delta = aH - a0;
      while (delta < 0.35) delta += TAU;
      maxTravel = Math.max(maxTravel, delta * DRIVE_R);
      c.van = van;
      c.houseAngle = aH;
      c.housePos = ringPos(HOUSE_R, aH);
      c.load = { pos: ringPos(LOAD_R, a0), yaw: tangentYaw(a0) };
      c.park = { pos: ringPos(PARK_R, aH), yaw: tangentYaw(aH) };
      c.drive = { a0, delta };
    });
    driveSpeed = Math.max(5.5, maxTravel / 4.2);

    pickupCount = (model.pickups || []).length;
    (model.pickups || []).forEach((b, j) => {
      const bag = makeBag(b.type, '#57534e');
      // Top shelf first: the bottom one is hidden under it from above.
      const slot = j % 24;
      const level = slot < 12 ? 1 : 0;
      const rowIdx = Math.floor((slot % 12) / 6);
      const col = slot % 6;
      bag.home.set(RACK_POS.x - 0.75 + col * 0.3, [0.345, 0.725][level], RACK_POS.z + (rowIdx ? 0.13 : -0.13));
      bag.baseScale = 0.95;
      bag.pickup = true;
      bag.obj.userData.sel = { type: 'pickup' };
      dyn.add(bag.obj);
      allBags.push(bag);
    });

    clusters.forEach(c => {
      const sel = { type: 'group', key: c.key };
      c.pilePin = addPin({
        text: c.label,
        color: c.color,
        sel,
        pos: () => tmp.set(c.center.x, 0.85, c.center.z),
        visible: () => stage <= 1 && (camera.zoom >= PIN_ZOOM || selected?.key === c.key),
        dynamic: true
      });
      c.vanPin = addPin({
        text: c.label,
        color: c.color,
        sel,
        pos: () => tmp.set(c.van.obj.position.x, 1.05, c.van.obj.position.z),
        visible: () => stage >= 2,
        dynamic: true
      });
    });

    kitchenPin.el.textContent = `\u{1F373} ${meals} meals`;
    printerPin.el.textContent = `\u{1F3F7}️ ${bagsTotal} labels`;
    pickupPin.el.textContent = `Pickup · ${pickupCount}`;
    stage = stageNow;
    wanted = stageNow;
    snap(stageNow);
    if (selected) select(selected);
  }

  function setVanDone(c, done) {
    c.vanPin.el.textContent = done ? `✓ ${c.label}` : c.label;
    c.vanPin.el.classList.toggle('done', done);
  }

  // Final poses for a stage, no animation.
  function snap(s) {
    for (const bag of allBags) {
      bag.obj.position.copy(bag.home);
      bag.obj.rotation.set(0, 0, 0);
      bag.obj.scale.setScalar(bag.baseScale);
      setGhost(bag, s === 0);
      bag.obj.visible = bag.pickup ? s <= 2 : s <= 1;
    }
    for (const c of clusters) {
      const pose = s <= 1 ? c.load : c.park;
      c.van.obj.position.copy(pose.pos);
      c.van.obj.rotation.set(0, pose.yaw, 0);
      setVanDone(c, s === 3);
    }
    smokeTarget = s <= 1 ? 1 : s === 2 ? 0.35 : 0;
    winMat.emissiveIntensity = s <= 2 ? 0.55 : 0.12;
    ledMat.emissiveIntensity = s >= 1 ? 0.9 : 0.3;
  }

  // ---------- tweens ----------
  const tweens = new Set();
  let cancelHooks = [];
  let clockNow = 0;
  function tween({ delay = 0, duration = 0.5, ease: e = ease.inOut, update, done, keep = false }) {
    const t = { start: clockNow + delay, duration: Math.max(duration, 0.001), ease: e, update, done, keep, begun: false };
    tweens.add(t);
    return t;
  }
  function runTweens() {
    for (const t of [...tweens]) {
      if (clockNow < t.start) continue;
      const p = Math.min(1, (clockNow - t.start) / t.duration);
      t.update?.(t.ease(p), p);
      if (p >= 1) {
        tweens.delete(t);
        t.done?.();
      }
    }
  }
  function cancelAll() {
    for (const t of [...tweens]) if (!t.keep) tweens.delete(t);
    while (fx.children.length) fx.remove(fx.children[0]);
    particles.length = 0;
    const hooks = cancelHooks;
    cancelHooks = [];
    hooks.forEach(h => h());
  }
  // Wraps a stage animation: resolves true when it finishes, false if cancelled.
  function animation(build) {
    return new Promise(resolve => {
      let settled = false;
      const finish = ok => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      cancelHooks.push(() => finish(false));
      build(() => finish(true));
    });
  }

  // ---------- effects ----------
  const particles = [];
  const confettiColors = ['#f59e0b', '#ef4444', '#0891b2', '#8b5cf6', '#10b981', '#ec4899'];
  function burst(pos, color) {
    if (reducedMotion) return;
    for (let i = 0; i < 24; i++) {
      const m = mesh(G.confetti, std(i % 3 === 0 ? color : confettiColors[i % confettiColors.length]));
      m.position.copy(pos);
      const a = Math.random() * TAU;
      const sp = 0.8 + Math.random() * 1.4;
      particles.push({
        m,
        v: new THREE.Vector3(Math.cos(a) * sp, 2.6 + Math.random() * 1.8, Math.sin(a) * sp),
        spin: new THREE.Vector3(Math.random() * 9, Math.random() * 9, Math.random() * 9),
        life: 0,
        max: 1.3 + Math.random() * 0.5
      });
      fx.add(m);
    }
  }
  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      p.v.y -= 6.5 * dt;
      p.m.position.addScaledVector(p.v, dt);
      p.m.rotation.x += p.spin.x * dt;
      p.m.rotation.y += p.spin.y * dt;
      p.m.rotation.z += p.spin.z * dt;
      const k = p.life / p.max;
      if (k >= 1 || p.m.position.y < 0.02) {
        fx.remove(p.m);
        particles.splice(i, 1);
      } else if (k > 0.7) {
        p.m.scale.setScalar((1 - k) / 0.3);
      }
    }
  }
  function updateSmoke(t, dt) {
    smokeLevel += (smokeTarget - smokeLevel) * Math.min(1, dt * 1.5);
    for (const p of smoke) {
      const k = (t * 0.32 + p.userData.phase) % 1;
      p.visible = smokeLevel > 0.02;
      if (!p.visible) continue;
      p.position.set(
        chimneyTop.x + Math.sin(k * 6 + p.userData.phase * 9) * 0.12 + k * 0.35,
        chimneyTop.y + k * 1.7,
        chimneyTop.z + Math.cos(k * 5) * 0.08
      );
      p.scale.setScalar(0.1 + k * 0.32);
      p.material.opacity = (1 - k) * 0.55 * smokeLevel;
    }
  }

  // Labels shoot out of the printer and land on each bag.
  function animatePrint() {
    return animation(finish => {
      const order = allBags.slice();
      if (!order.length) {
        finish();
        return;
      }
      const stepT = Math.min(0.07, 2.4 / order.length);
      const flight = 0.6;
      let last = 0;
      order.forEach((bag, i) => {
        const fly = mesh(G.flyLabel, std(bag.labelColor));
        fly.visible = false;
        fx.add(fly);
        const start = printerOut.clone();
        const end = bag.home.clone().setY(bag.home.y + 0.42 * bag.baseScale);
        const delay = i * stepT;
        last = Math.max(last, delay + flight);
        tween({
          delay,
          duration: flight,
          update: e => {
            fly.visible = true;
            fly.position.lerpVectors(start, end, e);
            fly.position.y += Math.sin(Math.PI * e) * 1.2;
            fly.rotation.y = e * 7;
          },
          done: () => {
            fx.remove(fly);
            setGhost(bag, false);
            tween({
              duration: 0.38,
              ease: ease.back,
              update: e => bag.obj.scale.setScalar(bag.baseScale * (0.65 + 0.35 * e))
            });
          }
        });
      });
      tween({
        duration: last,
        ease: ease.linear,
        update: (e, p) => {
          ledMat.emissiveIntensity = 0.4 + 0.6 * Math.abs(Math.sin(p * last * 14));
        },
        done: () => {
          ledMat.emissiveIntensity = 0.9;
        }
      });
      tween({ delay: last + 0.4, duration: 0.01, done: finish });
    });
  }

  // The list goes out: a paper plane takes off, bags hop into their vans,
  // and the vans drive around the ring to their houses.
  let driveSpeed = 5.5;
  function animateCopy() {
    return animation(finish => {
      const plane = new THREE.Mesh(planeGeo, std('#25d366', { side: THREE.DoubleSide, roughness: 0.5 }));
      plane.scale.setScalar(2.2);
      fx.add(plane);
      trail.forEach(d => {
        d.visible = false;
        fx.add(d);
      });
      // Off the kitchen roof, a low pass over the waiting vans, then away.
      const path = new THREE.CatmullRomCurve3([
        new THREE.Vector3(KITCHEN_POS.x + 0.4, 2.3, KITCHEN_POS.z + 0.7),
        new THREE.Vector3(1.9, 3.3, 1.0),
        new THREE.Vector3(0, 2.1, LOAD_R + 0.3),
        new THREE.Vector3(-3.4, 4.2, 4.0),
        new THREE.Vector3(-6, 13, 1.5)
      ]);
      const ahead = new THREE.Vector3();
      tween({
        duration: 2.4,
        ease: ease.inOut,
        update: e => {
          path.getPointAt(e, plane.position);
          path.getPointAt(Math.min(1, e + 0.01), ahead);
          if (ahead.distanceToSquared(plane.position) > 1e-6) plane.lookAt(ahead);
          trail.forEach((d, k) => {
            const te = e - (k + 1) * 0.018;
            d.visible = te > 0;
            if (d.visible) path.getPointAt(te, d.position);
          });
        },
        done: () => {
          fx.remove(plane);
          trail.forEach(d => fx.remove(d));
        }
      });

      let loadEnd = 0.3;
      clusters.forEach((c, ci) => {
        const target = c.load.pos.clone().setY(0.55);
        c.bags.forEach((bag, j) => {
          const delay = 0.3 + ci * 0.06 + j * 0.07;
          const start = bag.home.clone();
          loadEnd = Math.max(loadEnd, delay + 0.5);
          tween({
            delay,
            duration: 0.5,
            update: e => {
              bag.obj.position.lerpVectors(start, target, e);
              bag.obj.position.y += Math.sin(Math.PI * e) * 1.0;
              bag.obj.scale.setScalar(bag.baseScale * (1 - 0.65 * e));
            },
            done: () => {
              bag.obj.visible = false;
            }
          });
        });
      });

      // Leader first (the van furthest along the ring) so the convoy never overlaps.
      let end = loadEnd;
      clusters
        .map((c, k) => k)
        .sort((a, b) => b - a)
        .forEach((k, idx) => {
          const c = clusters[k];
          const delay = loadEnd + 0.15 + idx * 0.2;
          const dur = (c.drive.delta * DRIVE_R) / driveSpeed;
          end = Math.max(end, delay + dur);
          const { a0, delta } = c.drive;
          const inFrac = Math.min(0.3, 0.9 / (delta * DRIVE_R));
          const outFrac = Math.min(0.3, 1.0 / (delta * DRIVE_R));
          const prev = c.load.pos.clone();
          tween({
            delay,
            duration: dur,
            update: e => {
              const a = a0 + delta * e;
              let r = DRIVE_R;
              if (e < inFrac) r = lerp(LOAD_R, DRIVE_R, smooth(e / inFrac));
              else if (e > 1 - outFrac) r = lerp(DRIVE_R, PARK_R, smooth((e - (1 - outFrac)) / outFrac));
              const pos = c.van.obj.position;
              prev.copy(pos);
              pos.set(Math.cos(a) * r, 0, Math.sin(a) * r);
              const dx = pos.x - prev.x;
              const dz = pos.z - prev.z;
              const dist = Math.hypot(dx, dz);
              if (dist > 1e-5) {
                c.van.obj.rotation.y = yawFor(dx, dz);
                c.van.wheels.forEach(w => {
                  w.rotation.z -= dist / 0.1;
                });
              }
            },
            done: () => {
              c.van.obj.position.copy(c.park.pos);
              c.van.obj.rotation.set(0, c.park.yaw, 0);
            }
          });
        });
      tween({
        delay: end - 0.2,
        duration: 0.01,
        done: () => {
          stage = 2; // van pins appear while the last van parks
        }
      });
      tween({ delay: end + 0.3, duration: 0.01, done: finish });
    });
  }

  // Every van hops at its house; confetti; pickup bags get collected.
  function animateDelivered() {
    return animation(finish => {
      let end = 0;
      clusters.forEach((c, k) => {
        const delay = k * 0.14;
        end = Math.max(end, delay + 0.5);
        tween({
          delay,
          duration: 0.5,
          ease: ease.linear,
          update: e => {
            c.van.obj.position.y = Math.sin(Math.PI * e) * 0.38;
          },
          done: () => {
            c.van.obj.position.y = 0;
            setVanDone(c, true);
            burst(c.housePos.clone().setY(1.2), c.color);
          }
        });
      });
      allBags
        .filter(b => b.pickup && b.obj.visible)
        .forEach((bag, i) => {
          const delay = 0.2 + i * 0.04;
          end = Math.max(end, delay + 0.35);
          tween({
            delay,
            duration: 0.35,
            update: e => bag.obj.scale.setScalar(bag.baseScale * (1 - e)),
            done: () => {
              bag.obj.visible = false;
            }
          });
        });
      smokeTarget = 0;
      winMat.emissiveIntensity = 0.12;
      tween({ delay: end + 0.6, duration: 0.01, done: finish });
    });
  }

  // ---------- stage machine ----------
  let wanted = 0;
  let running = false;
  const ANIMS = { 1: animatePrint, 2: animateCopy, 3: animateDelivered };
  function setStage(target) {
    wanted = target;
    if (running) {
      if (target < stage) cancelAll();
      return;
    }
    if (target <= stage || reducedMotion || !clusters.length) {
      stage = target;
      snap(target);
      return;
    }
    run();
  }
  async function run() {
    running = true;
    while (stage < wanted) {
      // Skipping ahead (say, copying before printing): only the last step plays.
      if (wanted - stage > 1) {
        stage = wanted - 1;
        snap(stage);
      }
      const next = stage + 1;
      const ok = await ANIMS[next]();
      if (!ok) break;
      stage = next;
      snap(next);
    }
    running = false;
    if (stage !== wanted) {
      stage = wanted;
      snap(wanted);
    }
  }

  // ---------- camera, controls, selection ----------
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(HOME_TARGET);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minZoom = 0.7;
  controls.maxZoom = 3.2;
  controls.minPolarAngle = THREE.MathUtils.degToRad(26);
  controls.maxPolarAngle = THREE.MathUtils.degToRad(70);
  controls.rotateSpeed = 0.7;
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };
  controls.autoRotate = !reducedMotion;
  controls.autoRotateSpeed = 0.55;
  let resumeTimer = null;
  let selected = null;
  const resumeSpin = ms => {
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      if (!selected && !reducedMotion) controls.autoRotate = true;
    }, ms);
  };
  controls.addEventListener('start', () => {
    controls.autoRotate = false;
    clearTimeout(resumeTimer);
  });
  controls.addEventListener('end', () => resumeSpin(7000));

  function selPosition(sel) {
    if (!sel) return HOME_TARGET.clone();
    if (sel.type === 'kitchen') return KITCHEN_POS.clone().setY(0.9);
    if (sel.type === 'printer') return PRINTER_POS.clone().setY(0.5);
    if (sel.type === 'pickup') return RACK_POS.clone().setY(0.5);
    const c = clusters.find(x => x.key === sel.key);
    if (!c) return HOME_TARGET.clone();
    return (stage <= 1 ? c.center.clone() : c.van.obj.position.clone()).setY(0.4);
  }
  // Pans camera and target together, so the viewing angle doesn't change.
  let focusTween = null;
  function focusTo(point, zoom) {
    if (focusTween) tweens.delete(focusTween);
    const fromT = controls.target.clone();
    const fromZ = camera.zoom;
    const next = new THREE.Vector3();
    focusTween = tween({
      duration: reducedMotion ? 0.01 : 0.75,
      keep: true,
      update: e => {
        next.lerpVectors(fromT, point, e);
        camera.position.add(tmp.subVectors(next, controls.target));
        controls.target.copy(next);
        camera.zoom = lerp(fromZ, zoom, e);
        camera.updateProjectionMatrix();
      }
    });
  }
  function select(sel) {
    selected = sel || null;
    if (!selected) {
      ring.visible = false;
      focusTo(HOME_TARGET, 1);
      resumeSpin(1500);
      return;
    }
    controls.autoRotate = false;
    clearTimeout(resumeTimer);
    const c = selected.type === 'group' ? clusters.find(x => x.key === selected.key) : null;
    ring.visible = !!c;
    if (c) ringMat.color.set(c.color);
    focusTo(selPosition(selected), c ? 1.85 : 1.55);
  }
  function updateRing(t) {
    if (!ring.visible || !selected) return;
    const c = clusters.find(x => x.key === selected.key);
    if (!c) {
      ring.visible = false;
      return;
    }
    const p = stage <= 1 ? c.center : c.van.obj.position;
    ring.position.set(p.x, 0.02, p.z);
    const base = stage <= 1 ? (cellSize / 1.35) * 1.05 : 1.0;
    ring.scale.setScalar(base * (1 + Math.sin(t * 4) * 0.06));
  }

  // Taps (not drags) pick whatever is under the finger.
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let down = null;
  const isShown = o => {
    for (let x = o; x; x = x.parent) if (!x.visible) return false;
    return true;
  };
  function onPointerDown(e) {
    down = { x: e.clientX, y: e.clientY, t: performance.now() };
  }
  function onPointerUp(e) {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.t < 600;
    down = null;
    if (moved > 7 || !quick) return;
    const rect = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects([kitchen, printer, rack, dyn], true);
    for (const h of hits) {
      if (!isShown(h.object)) continue;
      let o = h.object;
      while (o && !o.userData.sel) o = o.parent;
      if (o) {
        onSelect?.(o.userData.sel);
        return;
      }
    }
    onSelect?.(null);
  }
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);

  // Wide screens frame the whole island; phones frame the ring of houses and
  // let the outer trees run off the edges, so everything is bigger.
  function fit() {
    viewW = container.clientWidth || 1;
    viewH = container.clientHeight || 1;
    renderer.setSize(viewW, viewH, false);
    const aspect = viewW / viewH;
    const r = viewW < 560 ? HOUSE_R + 0.75 : BASE_R + 0.4;
    const needW = r * 2;
    const needH = r * 2 * Math.sin(THREE.MathUtils.degToRad(35)) + 2.6;
    const halfH = Math.max(needH / 2, needW / 2 / aspect);
    camera.left = -halfH * aspect;
    camera.right = halfH * aspect;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(fit);
  ro.observe(container);
  fit();

  // Intro: swing in and settle.
  if (!reducedMotion) {
    const sph = new THREE.Spherical().setFromVector3(tmp.subVectors(camera.position, HOME_TARGET));
    const endTheta = sph.theta;
    tween({
      duration: 1.6,
      ease: ease.out,
      keep: true,
      update: e => {
        sph.theta = endTheta - 0.9 * (1 - e);
        camera.position.setFromSpherical(sph).add(controls.target);
        camera.zoom = lerp(0.72, 1, e);
        camera.updateProjectionMatrix();
      }
    });
  }

  // ---------- loop ----------
  const t0 = performance.now();
  let lastFrame = t0;
  let raf = 0;
  // Scrolled out of sight: keep the tweens moving but skip drawing (saves
  // the phone's battery).
  let onScreen = true;
  const io = new IntersectionObserver(entries => {
    onScreen = entries[entries.length - 1].isIntersecting;
  });
  io.observe(container);
  function frame() {
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min((now - lastFrame) / 1000, 0.05);
    lastFrame = now;
    clockNow = (now - t0) / 1000;
    runTweens();
    if (!onScreen) return;
    updateSmoke(clockNow, dt);
    updateParticles(dt);
    updateRing(clockNow);
    controls.update(dt);
    renderer.render(scene, camera);
    updatePins();
  }
  frame();

  return {
    setModel,
    setStage,
    select,
    zoomBy(f) {
      const target = THREE.MathUtils.clamp(camera.zoom * f, controls.minZoom, controls.maxZoom);
      const from = camera.zoom;
      tween({
        duration: 0.3,
        keep: true,
        update: e => {
          camera.zoom = lerp(from, target, e);
          camera.updateProjectionMatrix();
        }
      });
    },
    resetView() {
      onSelect?.(null);
      select(null);
    },
    dispose() {
      cancelAnimationFrame(raf);
      clearTimeout(resumeTimer);
      ro.disconnect();
      io.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      controls.dispose();
      cancelAll();
      dynDisposables.forEach(d => d.dispose());
      disposables.forEach(d => d.dispose());
      renderer.dispose();
      canvas.remove();
      overlay.remove();
    }
  };
}
