/**
 * @todo Bounding box in god mode.
 * @todo Offset touch target to above fingertip so it's visible.
 * @todo Distinct touch interactions for moving target versus camera.
 * @todo Make camera move more consistently, especially dolly out...
 * @todo Style updates according to Terrence's mood, colour, post references.
 * @todo Replay time: add shapes in sequence (by `_sortKey` or `_id`?),
 *   on intro or idle.
 *
 * @todo Address Terrence's Figma notes.
 * @todo Add sphere BVH to optimise later.
 */

import { Olta } from '@olta/js-sdk';

import {
    WebGLRenderer, Scene, Raycaster, PerspectiveCamera, Clock,
    Vector2, Vector3, Vector4, Quaternion, Matrix4, Spherical, Box3, Sphere,
    InstancedMesh, SphereGeometry, CylinderGeometry, BoxGeometry,
    MeshToonMaterial, MeshBasicMaterial,
    HemisphereLight, PointLight, Color, MathUtils, Fog, DoubleSide,
    BufferGeometry, Mesh, Group, TextureLoader, NearestFilter,
    NumberKeyframeTrack, VectorKeyframeTrack,
    AnimationClip, AnimationMixer,
    InterpolateSmooth, InterpolateLinear,
    LoopOnce, LoopPingPong,
    Object3D
  } from 'three';

import Stats from 'three/examples/jsm/libs/stats.module.js';
import CameraOrbitControls from 'camera-controls';

import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast }
  from 'three-mesh-bvh';

import { each } from '@epok.tech/fn-lists/each';
import { map } from '@epok.tech/fn-lists/map';
import { reduce } from '@epok.tech/fn-lists/reduce';
import { range } from '@epok.tech/fn-lists/range';

const gradientMapURL = new URL('assets/tone-5.jpg', import.meta.url);

const { random, round, floor, min, max, abs, acos, PI: pi } = Math;
const { MAX_SAFE_INTEGER: intMax, EPSILON: eps } = Number;
const { lerp, inverseLerp: unlerp, clamp } = MathUtils;

const api = self.echoes = {};

const cache = api.cache = {
  transform: new Matrix4(),
  colors: [new Color(), new Color()],
  spheres: [new Sphere()],
  vector3s: [new Vector3(), new Vector3(), new Vector3()]
};

const query = api.query = new URLSearchParams(location.search);
const god = api.god = query.has('god');

let wallet;

const $root = api.$root = document.documentElement;
const $body = api.$body = document.body;
const $canvas = api.$canvas = document.querySelector('canvas');

const $teamPicks = api.$teamPicks = document
  .querySelectorAll('.team-picker .team');

function tween(at, to, ease, dt) {
  const d = dt && to-at;

  return d && at+(d*ease*dt);
}

const depths = api.depths = [1, 1e4];
const [near, far] = depths;

// Bounds are for maximum range and accuracy as `olta` only accepts integers.
const bounds = api.bounds = [-intMax, intMax];

// Bounds rescaled by this for front-end convenience with `three`.
const positionScale = api.positionScale = 3e-13;

const radii = api.radii = [1, 1e2];
const [r0, r1] = radii;

const boundRadius = (intMax*positionScale)+r1;

const boundary = api.boundary = new Box3();

boundary.min.setScalar(-boundRadius);
boundary.max.setScalar(boundRadius);

const scales = api.scales = { growth: 1.5, shrink: 0.9, inner: 0.95, hit: 0.2 };

const colors = api.colors = {
  // any: [0x3033d4, 0xb02940, 0xefa53b],
  teams: [
    new Color('hsl(229, 82%, 46%)'),
    new Color('hsl(309, 72%, 38%)'),
    new Color('hsl(39, 95%, 48%)')
  ],
  // HSL offsets.
  own: [0, 0.2, 0],
  hunt: [0.05, 0, 0],
  flee: [-0.05, 0, 0],
  grow: [0, 0, 0.15]
};

const colorAt = (team, to = new Color()) => to.copy(colors.teams[team]);
const colorTo = (by, to = new Color()) => to.offsetHSL(...colors[by]);

const colorMix = (alpha, by, to = new Color(), c = new Color()) =>
  to.lerpHSL(colorTo(by, c.copy(to)), alpha);

const teams = api.teams = colors.teams.length;
let team = api.team = 0;
const hunt = (t) => (t+1)%teams;
const flee = (t) => (t+2)%teams;

function teamTo(t) {
  console.log('picked team', team = api.team = t);
  $root.classList.add('team-picked', 'team-picked-'+t);
  api.fence?.material?.color?.copy?.(colors.teams[t]);
}

each((c, i) => $root.style.setProperty('--team-color-'+i, '#'+c.getHexString()),
  colors.teams);

const size = new Vector2();

// BVH is only maybe used by `orbit`, `forms` use sphere intersection instead.
BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

CameraOrbitControls.install({
  THREE: {
    WebGLRenderer, Raycaster,
    Vector2, Vector3, Vector4, Quaternion, Matrix4, Spherical, Box3, Sphere
  }
});

const renderer = api.renderer =
  new WebGLRenderer({ canvas: $canvas, antialias: true });

renderer.setPixelRatio(devicePixelRatio);
renderer.setClearColor(0xffffff);

const scene = api.scene = new Scene();
const clock = api.clock = new Clock();

const camera = api.camera = new PerspectiveCamera(60, 1, ...depths);
const orbit = api.orbit = new CameraOrbitControls(camera, $canvas);
// const orbitStart = boundRadius*2;
const orbitStart = 0;

orbit.maxSpeed = 1e3;
orbit.smoothTime = 0.1;
orbit.infinityDolly = orbit.dollyToCursor = true;
orbit.minDistance = orbit.maxDistance = r1;
orbit.dollySpeed = 10;
orbit.truckSpeed = 10;
orbit.boundaryEnclosesCamera = true;
orbit.setBoundary(boundary);
orbit.setLookAt(0, 0, orbitStart+orbit.minDistance, 0, 0, orbitStart);
orbit.saveState();

const fog = api.fog = {
  at: scene.fog = new Fog(0xffffff, 0, 0), ease: 0.2,
  tween(dt) {
    const { at: f, ease: e } = fog;
    const { near: fn, far: ff } = f;

    f.near = tween(fn, near, e, dt);
    f.far = tween(ff, far, e, dt);
  }
};

const lightCamera = api.lightCamera = new PointLight(0xffffff, 5e4, 0, 1.7);

lightCamera.position.set(0, r1, 0);
scene.add(camera.add(lightCamera));

const lightSky = api.lightSky = new HemisphereLight(0xffffff, 0x000000, 0.5);

scene.add(lightSky);

const textureLoader = new TextureLoader();
const gradientMap = textureLoader.load(gradientMapURL);

gradientMap.minFilter = gradientMap.magFilter = NearestFilter;

const forms = api.forms = {
  geometry: new SphereGeometry(1),
  material: new MeshToonMaterial({ gradientMap }),
  data: [], meshes: [], limits: []
};

forms.geometry.computeBoundsTree();

function dataToSphere({ x, y, z, r }, s) {
  s.center.set(x, y, z).multiplyScalar(positionScale);
  s.radius = r;

  return s;
}

const hint = api.hint = {
  mesh: new Mesh(forms.geometry, new MeshToonMaterial({
    transparent: true, opacity: 0.4, side: DoubleSide, depthWrite: false,
    gradientMap
  })),
  radius: 0, ease: 1e1,
  tween(dt) {
    const { radius: r, ease: e, mesh: { scale: s } } = hint;
    const sr = s.x;

    s.setScalar(tween(sr, r, e, dt));
  }
};

const hintCamera = api.hintCamera = new Object3D();

hintCamera.position.set(0, 0, -r1*2);
camera.add(hintCamera);

const hold = api.hold = {
  mesh: new Mesh(hint.mesh.geometry, hint.mesh.material.clone()),
  frames: {}, wait: 1e3,
  at: new Vector2(), moved2: 20
};

hint.mesh.scale.setScalar(hint.radius);
scene.add(hint.mesh.add(hold.mesh));

(function animateHold() {
  const { mesh, frames, wait } = hold;
  const mixer = hold.mixer = new AnimationMixer(mesh);
  const { material, scale } = mesh;
  const times = [0, wait*1e-3];

  const fo = frames.opacity = new NumberKeyframeTrack('.material.opacity',
    times, [1, material.opacity*0.1], InterpolateSmooth);

  const fs = frames.scale = new VectorKeyframeTrack('.scale',
    times, scale.toArray(range(6, eps), 3), InterpolateSmooth);

  const clip = hold.clip = new AnimationClip('@', -1, [fs, fo]);
  const action = hold.action = mixer.clipAction(clip);

  // action.setLoop(LoopOnce, 1);
  action.setLoop(LoopPingPong, Infinity);
})();

const hit = api.hit = new Mesh(new CylinderGeometry(0.1, 0.5, 1, 2**5, 1, true),
  new MeshToonMaterial({
    transparent: true, opacity: 0.6, side: DoubleSide, depthWrite: false,
    color: hint.mesh.material.color.clone(), fog: false, gradientMap,
    emissiveIntensity: 0.8
  }));

hit.material.emissive = hit.material.color;
hit.geometry.translate(0, 0.5, 0);
hit.geometry.rotateX(pi*0.5);
scene.add(hit);

const hitFlip = (on) => $root.classList.toggle('hit', hit.visible = on);

hitFlip(false);

const traces = api.traces = {
  group: new Group(),
  mesh: new Mesh(forms.geometry,
    new MeshToonMaterial({
      transparent: true, opacity: 0.6, side: DoubleSide, depthWrite: false,
      color: hint.mesh.material.color.clone(), fog: false, gradientMap
    })),
  frames: { drawRangeSpeed: 1 }
};

// @todo Work out how to animate the `drawRange` here... can't parse the path.
// @todo Animate the clip planes of the `hint`.
(function animateTrace() {
  const { mesh, frames } = traces;
  const mixer = traces.mixer = new AnimationMixer(mesh);
  const o1 = mesh.material.opacity;
  const o0 = o1*0.5;

  const fo = frames.opacity = new NumberKeyframeTrack('.material.opacity',
    [0, 0.9, 1.6], [o0, o1, o0], InterpolateSmooth);

  const clip = traces.clip = new AnimationClip('@', -1, [fo]);

  (traces.action = mixer.clipAction(clip)).play();
})();

function toTrace(x, y, z, r) {
  const { mesh, group } = traces;
  const t = mesh.clone();
  const { position: p, scale: s, material } = t;

  p.set(x, y, z);
  s.multiplyScalar(r*scales.inner);
  material.color.copy(hint.mesh.material.color);
  // @todo Track the time it was added, to remove when its data arrives?
  group.add(t);

  return t;
}

scene.add(traces.group);

/** Display the bounds box for easier placement in god mode. */
if(god) {
  const fence = api.fence = new Mesh(new BoxGeometry(1, 1, 1, 1e2, 1e2, 1e2),
    new MeshBasicMaterial({ wireframe: true }));

  fence.scale.setScalar(bounds[1]*2*positionScale);
  scene.add(fence);
}

const raycaster = api.raycaster = new Raycaster();

raycaster.firstHitOnly = true;

const pointer = new Vector2();
const axes = new Vector2(1, -1);

const stats = api.stats = ((query.has('stats'))? new Stats() : null);

stats && $body.appendChild(stats.dom);

// let needRender = false;
const needRender = true;

const render = api.render = (dt = 0) => {
  // console.log('render');
  hold.mixer.update(dt);
  traces.mixer.update(dt);
  fog.tween(dt);
  hint.tween(dt);
  renderer.render(scene, camera);

  // const { geometry: g, frames: { drawRangeSpeed: drs } } = traces;
  // const { drawRange: { start: ds0, count: dc0 }, index: { count: gc } } = g;
  // const to = gc*0.3*drs*dt;
  // const ds1 = (ds0+to)%gc;
  // const dc1 = (dc0+to)%gc;

  // g.setDrawRange(min(ds1, dc1), max(ds1, dc1));

  // needRender = false;
};

const resize = api.resize = () => {
  const { width: w, height: h } = $canvas.getBoundingClientRect();

  size.set(w, h);
  renderer.setSize(w, h, 0);
  camera.aspect = w/h;
  camera.updateProjectionMatrix();
  render();
};

const frame = api.frame = () => {
  requestAnimationFrame(frame);

  const dt = clock.getDelta();

  (orbit.update(dt) || needRender) && render(dt);
  stats?.update?.();
};

const clearHeld = api.clearHeld = () => {
  const { held, action, mesh } = hold;

  // action.stop();
  action.paused = true;
  mesh.visible = false;
  clearTimeout(held);
  delete hold.held;

  return held;
};

$canvas.addEventListener('pointerup', clearHeld);
$canvas.addEventListener('pointercancel', clearHeld);
$canvas.addEventListener('pointerout', clearHeld);
$canvas.addEventListener('pointerleave', clearHeld);

function moveClearHeld(e) {
  const { held, at, moved2 } = hold;

  held && (at.distanceToSquared(e) > moved2) && clearHeld();
}

$canvas.addEventListener('pointermove', (e) => {
  const { data } = forms;

  moveClearHeld(e);
  // needRender = true;

  if(!data?.length) { return hint.radius = +hitFlip(false); }

  pointer.copy(e).divide(size).multiplyScalar(2).subScalar(1).multiply(axes);
  raycaster.setFromCamera(pointer, camera);

  const { ray, ray: { origin: ro } } = raycaster;
  const { spheres: [s], vector3s: [p, v, c], colors: [color] } = cache;
  let at;

  const l2 = reduce((l2, ds) =>
      reduce((l2, d) => {
        if(!ray.intersectSphere(dataToSphere(d, s), v)) { return l2; }

        const vl2 = v.distanceToSquared(ro);

        if(l2 < vl2) { return l2; }

        at = d;
        p.copy(v);
        c.copy(s.center);

        return vl2;
      },
      ds, l2),
    data, Infinity);

  if(l2 === Infinity) { return hint.radius = +hitFlip(false); }

  const { t } = at;
  let ar = at.r;
  const { growth: sg, shrink: ss, hit: sh } = scales;
  const hitColor = hit.material.color;

  hit.lookAt(v.copy(hit.position.copy(p)).add(p).sub(c));
  hitFlip(true);

  if(t !== team) {
    // colorTo(((t === hunt(team))? 'hunt' : 'flee'),
    //   colorTo('own', colorAt(team, hitColor)));
    colorTo('own', colorAt(team, hitColor));
    hit.scale.setScalar(ar*sh);

    return hint.radius = 0;
  }

  // Check the other team forms intersected:
  // - Increase radius if touching a team to `hunt`.
  // - Decrease radius to avoid touching a team to `flee`.
  const { [hunt(team)]: dh, [flee(team)]: df } = data;
  let r = ar = max(ar*ss, r0);

  // Check `hunt` first, increase radius if touched, proportional to how much of
  // each form (radius) is crossed.
  // @todo Optimise using squared-distance comparisons.
  r *= min(sg,
    reduce((to, d) =>
        to+max(min(r-dataToSphere(d, s).distanceToPoint(p), s.radius, r)/r, 0),
      dh, 1));

  // Check `flee` and decrease radius to nearest touch.
  // @todo Optimise using squared-distance comparisons.
  r = reduce((to, d) => min(to, dataToSphere(d, s).distanceToPoint(p)), df, r);

  if(r < r0) { return hint.radius = 0; }

  const hintColor = colorAt(team, hint.mesh.material.color);

  if(r === ar) { hitColor.setHex(0); }
  else {
    colorTo(((r < ar)? 'flee' : 'hunt'), hintColor);
    colorAt(((r < ar)? flee : hunt)(team), hitColor);
  }

  r = min(r, r1);
  colorMix(unlerp(...radii, r), 'grow', hintColor, color);
  hint.radius = r;
  hint.mesh.position.copy(p);
  hit.scale.setScalar(r*sh);
});

$canvas.addEventListener('pointerdown', (e) => {
  const { button, pointerId } = e;
  const alt = (button === 2);
  const spawn = god && alt && !hit.visible;
  // const clean = god && alt && hit.visible;
  const { mesh, wait, action, at } = hold;
  const { position: hp, scale: hs, material: { color: hc } } = hint.mesh;

  if(spawn) {
    colorAt(team, hc);
    hs.setScalar(hint.radius = r1);
    hintCamera.getWorldPosition(hp);
  }

  clearHeld();
  mesh.material.color.copy(hc);
  mesh.visible = true;
  action.stop().play();
  at.copy(e);

  function go(r) {
    if(!r) { return; }

    const { x, y, z } = hp;
    const ps = positionScale;

    // @todo Check `state` settings to use dynamically, for limits etc?
    const to = {
      t: team,
      x: round(clamp(x/ps, ...bounds)),
      y: round(clamp(y/ps, ...bounds)),
      z: round(clamp(z/ps, ...bounds)),
      r: round(clamp(r, ...radii))
    };

    console.log('create', to);
    olta.create('forms', to);
    toTrace(x, y, z, r);
    mesh.visible = false;
    hs.setScalar(hint.radius = 0);
    // needRender = true;
  }

  if(!spawn) {
    return hold.held = setTimeout(() => clearHeld() && go(hint.radius), wait);
  }

  $root.addEventListener('pointerup', function spawned(e) {
    if(pointerId !== e.pointerId) { return; }

    $root.removeEventListener('pointerup', spawned);
    go(mesh.scale.x*hint.radius);
    clearHeld();
  });
});

// @todo Find a way to sensibly set the camera to orbit around the intersection.
// orbit.addEventListener('controlstart', () => {
//   const { visible: v, position: p } = hit;

//   if(!v) { return; }

//   const { x: px, y: py, z: pz } = p;

//   orbit.setOrbitPoint(px, py, pz);
//   needRender = true;
// });

/** Convenience function for adding forms from developer console. */
god && (api.spawn = (r = lerp(...radii, 0.25), t = team, x, y, z) => {
  const p = camera.position;

  const to = {
    t,
    x: round(clamp(x ?? p.x/positionScale, ...bounds)),
    y: round(clamp(y ?? p.y/positionScale, ...bounds)),
    z: round(clamp(z ?? p.z/positionScale, ...bounds)),
    r: round(clamp(r, ...radii))
  };

  console.log('spawn', to);

  return olta.create('forms', to);
});

hint.mesh.material.emissive = hint.mesh.material.color;
hint.mesh.material.emissiveIntensity = 0.5;

addEventListener('resize', resize);
resize();

const olta = api.olta = Olta();

const dataToScene = api.dataToScene = (to) => {
  // @todo Construct a KD-Tree, and only create enough meshes for nearby range.
  const tl = to.length;
  const { geometry, material, data, meshes, limits } = forms;
  const { transform, colors: [c0, c1] } = cache;

  if(!tl) {
    each((m) => m.removeFromParent().dispose(), meshes);

    return data.length = limits.length = meshes.length = 0;
  }

  map(() => [],
    ((data.length)? data : ((data.length = teams) && range(data))), 0);

  // Group data by team.
  each((v) => data[v.t].push(v), to);

  each((d, t) => {
      const dl = d.length;
      let m = meshes[t];

      // Set up a larger instanced mesh if needed.
      if(!m || ((limits[t] ?? 0) < dl)) {
        m?.removeFromParent?.().dispose?.();

        scene.add(m = meshes[t] =
          new InstancedMesh(geometry, material, limits[t] = dl));
      }
      // Just reduce the instance draw count if the limit is high enough.
      else { m.count = dl; }

      // Set up the mesh instances.
      const ps = positionScale;

      each(({ x, y, z, r, _creator }, i) => {
          m.setMatrixAt(i,
            transform.makeScale(r, r, r).setPosition(x*ps, y*ps, z*ps));

          colorAt(t, c0);
          (_creator === wallet) && colorTo('own', c0);
          colorMix(unlerp(...radii, r), 'grow', c0, c1);
          m.setColorAt(i, c0);
        },
        d);

      m.instanceMatrix.needsUpdate = m.instanceColor.needsUpdate = true;
    },
    data);

  // needRender = true;
};

const update = api.update = (state) => {
  const to = olta.getAll('forms');

  console.log('data', to, state);

  if(!to) { return; }

  dataToScene(to);
  console.log('wallet', wallet = state.projectState.activeWalletAddress);
};

olta.onUpdate(update);

each(($b) => $b.addEventListener('click', () => {
    orbit.reset(true);
    // Doesn't seem to work with the above reset?
    // orbit.setLookAt(0, 0, orbitStart+orbit.minDistance, 0, 0, orbitStart, true);
  }),
  document.querySelectorAll('.recenter'));

each(($p, i) => $p.addEventListener('click', () => {
    teamTo(i);
    setTimeout(frame, 9e2);
  }),
  $teamPicks);
