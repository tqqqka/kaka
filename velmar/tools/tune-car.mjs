// Подбор параметров машины в Rapier без рендера.
import RAPIER from '@dimforge/rapier3d-compat';
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = 1 / 60;
const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
world.createCollider(RAPIER.ColliderDesc.cuboid(2000, 1, 2000).setTranslation(0, -1, 0), ground);
const P = { mass: 1300, engine: 5200, brake: 55, R: 0.33, rest: 0.3, stiff: 32, comp: 2.6, relax: 3.4, slip: 2.4, side: 1.0, hx: 0.88, hy: 0.45, hz: 2.2, cy: 0.78, wb: 2.7, tr: 1.56 };
const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.4, 0).setLinearDamping(0.05).setAngularDamping(0.6).setCanSleep(false));
const col = world.createCollider(RAPIER.ColliderDesc.cuboid(P.hx, P.hy, P.hz).setTranslation(0, P.cy, 0)
  .setMassProperties(P.mass, { x: 0, y: 0.42, z: 0 }, { x: P.mass * 0.9, y: P.mass * 1.6, z: P.mass * 0.5 }, { x: 0, y: 0, z: 0, w: 1 }), body);
const vc = world.createVehicleController(body);
vc.indexUpAxis = 1; vc.setIndexForwardAxis = 2;
const connY = P.R + P.rest - 0.1;
const W = [[P.tr / 2, connY, P.wb / 2], [-P.tr / 2, connY, P.wb / 2], [P.tr / 2, connY, -P.wb / 2], [-P.tr / 2, connY, -P.wb / 2]];
W.forEach(([x, y, z], i) => {
  vc.addWheel({ x, y, z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, P.rest, P.R);
  vc.setWheelSuspensionStiffness(i, P.stiff); vc.setWheelSuspensionCompression(i, P.comp); vc.setWheelSuspensionRelaxation(i, P.relax);
  vc.setWheelMaxSuspensionForce(i, P.mass * 40); vc.setWheelFrictionSlip(i, P.slip); vc.setWheelSideFrictionStiffness(i, P.side);
  vc.setWheelMaxSuspensionTravel(i, 0.25);
});
const fwd = () => { const q = body.rotation(); const v = body.linvel();
  // forward = q * (0,0,1)
  const fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y); return v.x * fx + v.z * fz; };
let t = 0; const log = [];
function step(engine, brake, steer) {
  for (let i = 0; i < 4; i++) { vc.setWheelEngineForce(i, i < 2 ? engine / 2 : 0); vc.setWheelBrake(i, brake); vc.setWheelSteering(i, i < 2 ? steer : 0); }
  vc.updateVehicle(1 / 60); world.step(); t += 1 / 60;
}
for (let i = 0; i < 60; i++) step(0, 0, 0);
console.log('rest y', body.translation().y.toFixed(3), 'susp', vc.wheelSuspensionLength(0)?.toFixed(3), 'contact', vc.wheelIsInContact(0));
let t100 = -1;
for (let i = 0; i < 60 * 20; i++) { const sp = fwd(); const f = sp > 50 ? 0 : P.engine; step(f, 0, 0); if (t100 < 0 && sp > 27.8) t100 = t; }
console.log('0-100 km/h', t100.toFixed(2), 's; speed after 20s', fwd().toFixed(1), 'pos', body.translation().z.toFixed(0), 'y', body.translation().y.toFixed(2));
// braking from current speed
const s0 = fwd(); let bt = 0; const z0 = body.translation().z;
while (fwd() > 0.5 && bt < 20) { step(0, P.brake, 0); bt += 1 / 60; }
console.log('brake from', s0.toFixed(1), 'm/s in', bt.toFixed(2), 's dist', (body.translation().z - z0).toFixed(1));
// steady turn at ~15 m/s
for (let i = 0; i < 300; i++) { const sp = fwd(); step(sp < 15 ? P.engine : 0, 0, 0); }
const q0 = body.rotation(); let maxRoll = 0;
for (let i = 0; i < 300; i++) { const sp = fwd(); step(sp < 15 ? P.engine : 0, 0, 0.35); const q = body.rotation(); const upy = 1 - 2 * (q.x * q.x + q.z * q.z); maxRoll = Math.max(maxRoll, Math.acos(Math.min(1, upy))); }
const av = body.angvel();
console.log('turn: speed', fwd().toFixed(1), 'yawrate', av.y.toFixed(2), 'maxTilt deg', (maxRoll * 57.3).toFixed(1));
