/**
 * Следы от пуль на стенах: кольцевой буфер инстансов (1 draw call).
 */
import * as THREE from 'three';
import { MaterialLib } from './Materials';

export class Decals {
  private mesh: THREE.InstancedMesh;
  private i = 0;
  private cap = 96;
  private _m = new THREE.Matrix4();
  private _q = new THREE.Quaternion();

  constructor(scene: THREE.Scene) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const ctx = cv.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    g.addColorStop(0, 'rgba(10,10,10,1)');
    g.addColorStop(0.3, 'rgba(25,22,20,0.9)');
    g.addColorStop(1, 'rgba(60,55,50,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(cv);
    const mat = MaterialLib.std({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, roughness: 0.9 });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.22, 0.22), mat, this.cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  bulletHole(p: THREE.Vector3, n: THREE.Vector3) {
    this._q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    this._m.compose(p.clone().addScaledVector(n, 0.01), this._q, new THREE.Vector3(1, 1, 1).multiplyScalar(0.7 + Math.random() * 0.6));
    this.mesh.setMatrixAt(this.i, this._m);
    this.i = (this.i + 1) % this.cap;
    this.mesh.count = Math.min(this.cap, this.mesh.count + 1);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
