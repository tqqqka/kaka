/**
 * Реестр материалов и патчи шейдеров.
 *
 * Все освещаемые материалы регистрируются здесь, чтобы:
 *  - подключить каскадные тени (CSM требует настройку каждого материала);
 *  - подключить общий «объёмный» высотный туман с подсветкой со стороны солнца;
 *  - добавить процедурные эффекты: окна небоскрёбов, разметку дорог, лужи в дождь,
 *    волны воды, детали кузова машин. Никаких текстур с диска: всё считается в шейдере.
 */
import * as THREE from 'three';
import type { CSM } from 'three/examples/jsm/csm/CSM.js';

/** Глобальные uniform'ы, разделяемые всеми материалами (одна ссылка на объект). */
export const SharedUniforms = {
  uTime: { value: 0 },
  /** 0 — день, 1 — ночь: свет в окнах, неон, фонари. */
  uNight: { value: 0 },
  /** 0..1 — мокрые поверхности после дождя. */
  uWetness: { value: 0 },
  uFogSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uFogSunColor: { value: new THREE.Color(1, 0.9, 0.7) },
  /** Скорость спада плотности тумана с высотой (1/м). */
  uFogHeight: { value: 0.012 },
};

// ---------------------------------------------------------------------------
// Глобальная замена фрагментов тумана: экспоненциальный высотный туман.
// Мировая позиция восстанавливается из mvPosition без обращения матрицы,
// поэтому работает для любых мешей (instanced, skinned, sprites).
// ---------------------------------------------------------------------------
THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vFogWorldPos;
#endif`;
THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogWorldPos = (mvPosition.xyz - viewMatrix[3].xyz) * mat3(viewMatrix);
#endif`;
THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying vec3 vFogWorldPos;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  uniform vec3 uFogSunDir;
  uniform vec3 uFogSunColor;
  uniform float uFogHeight;
#endif`;
THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  vec3 fogRay = vFogWorldPos - cameraPosition;
  float fogDist = length(fogRay);
  vec3 fogDir = fogRay / max(fogDist, 1e-3);
  #ifdef FOG_EXP2
    float fogB = max(uFogHeight, 1e-4);
    float fogDy = fogRay.y;
    float fogLine = fogDist * exp(-fogB * max(cameraPosition.y, 0.0));
    if (abs(fogDy) > 0.05) fogLine *= (1.0 - exp(-fogB * fogDy)) / (fogB * fogDy);
    float fogFactor = 1.0 - exp(-fogDensity * fogLine);
  #else
    float fogFactor = smoothstep(fogNear, fogFar, fogDist);
  #endif
  float fogSun = pow(max(dot(fogDir, uFogSunDir), 0.0), 6.0);
  vec3 fogCol = fogColor + uFogSunColor * fogSun;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogCol, clamp(fogFactor, 0.0, 1.0));
#endif`;

/** Общие GLSL-функции шума для процедурных поверхностей. */
const NOISE_GLSL = /* glsl */ `
float vhash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(vhash(i), vhash(i + vec2(1.0, 0.0)), u.x), mix(vhash(i + vec2(0.0, 1.0)), vhash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

export type MatKind = 'standard' | 'unlit' | 'facade' | 'road' | 'terrain' | 'water' | 'car' | 'foliage';

type Hook = (shader: THREE.WebGLProgramParametersWithUniforms, mat: THREE.Material) => void;

// ---------------------------------------------------------------------------
// Фасады зданий: окна, рамы, подсветка ночью, отражающее стекло.
// aFacade = (стиль, ширина ячейки, высота этажа, сид). uv = метры по стене/высоте.
// ---------------------------------------------------------------------------
const facadeHook: Hook = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
attribute vec4 aFacade;
varying vec4 vFacade;
varying vec2 vFacUv;
varying vec3 vFacWN;
varying vec3 vFacWP;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
vFacade = aFacade;
vFacUv = uv;
vFacWN = normalize(mat3(modelMatrix) * objectNormal);
vFacWP = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
uniform float uNight;
uniform float uWetness;
uniform float uTime;
varying vec4 vFacade;
varying vec2 vFacUv;
varying vec3 vFacWN;
varying vec3 vFacWP;
${NOISE_GLSL}`)
    .replace('#include <color_fragment>', `#include <color_fragment>
float fStyle = vFacade.x;
vec2 fCell = max(floor(vFacade.yz * 10.0 + 0.5) / 10.0, vec2(0.5));
// Сид округляется: иначе погрешность интерполяции varying даёт шум внутри окна.
float fSeed = floor(vFacade.w + 0.5);
fStyle = floor(fStyle + 0.5);
float fRoof = step(0.7, abs(vFacWN.y));
vec2 fq = vFacUv / fCell;
vec2 fid = floor(fq);
vec2 ff = fract(fq);
vec2 fm = vec2(0.3);
if (fStyle < 0.5) fm = vec2(0.035, 0.07);
else if (fStyle < 1.5) fm = vec2(0.15, 0.24);
else if (fStyle < 2.5) fm = vec2(0.27, 0.26);
else if (fStyle < 3.5) fm = vec2(0.22, 0.36);
else if (fStyle < 4.5) fm = vec2(2.0);
else fm = vec2(0.32, 0.3);
// Витрины первого этажа у жилых/офисных зданий.
float fGround = step(vFacUv.y, fCell.y * 1.05) * step(0.5, fStyle) * step(fStyle, 2.5);
if (fGround > 0.5) fm = vec2(0.06, 0.12);
vec2 fw = fwidth(fq) * 1.2 + 0.001;
vec2 fa = smoothstep(fm - fw, fm + fw, ff) * (1.0 - smoothstep(1.0 - fm - fw, 1.0 - fm + fw, ff));
float fWin = fa.x * fa.y * (1.0 - fRoof);
// У промышленных зданий окна только на каждом втором ряду.
if (fStyle > 2.5 && fStyle < 3.5) fWin *= step(0.5, fract(fid.y * 0.5 + 0.25));
float fR1 = vhash(fid + vec2(fSeed * 0.731, fSeed * 0.317));
float fR2 = vhash(fid.yx * 1.7 + vec2(fSeed * 0.113 + 11.0, fSeed * 0.071));
// Выветривание стен: пятна и вертикальные подтёки.
float fN = vnoise(vFacUv * vec2(0.35, 0.35) + fSeed) * 0.6 + vnoise(vec2(vFacUv.x * 1.8, vFacUv.y * 0.06) + fSeed) * 0.4;
vec3 fWall = diffuseColor.rgb * (0.78 + 0.34 * fN);
// Межэтажные пояса у стеклянных фасадов.
if (fStyle < 0.5) fWall *= 0.85 + 0.15 * step(0.5, ff.y);
if (fRoof > 0.5) {
  float g = vnoise(vFacWP.xz * 1.7) * 0.5 + vnoise(vFacWP.xz * 0.21) * 0.5;
  fWall = diffuseColor.rgb * (0.7 + 0.45 * g);
}
// Цвет стекла: тонировка по сиду + жалюзи днём.
vec3 fGlass = mix(vec3(0.10, 0.14, 0.18), vec3(0.16, 0.18, 0.16), vhash(vec2(fSeed, 3.0)));
if (fStyle > 1.5) fGlass = vec3(0.07, 0.08, 0.09);
fGlass *= 0.75 + 0.5 * fR2;
float fBlind = step(0.78, fR1) * (1.0 - fGround);
fGlass = mix(fGlass, vec3(0.34, 0.32, 0.28), fBlind * 0.6);
// Мокрые стены темнее.
fWall *= 1.0 - 0.25 * uWetness * (1.0 - fRoof);
diffuseColor.rgb = mix(fWall, fGlass, fWin);
// Ночная подсветка окон.
float fLitP = fStyle < 1.5 ? 0.38 : 0.5;
fLitP += 0.2 * (vhash(vec2(fSeed, 9.0)) - 0.5);
float fLit = step(1.0 - fLitP, fR2) + fGround;
vec3 fLitCol = mix(vec3(1.0, 0.72, 0.42), vec3(0.75, 0.86, 1.0), step(0.62, fR1));
fLitCol = mix(fLitCol, vec3(0.45, 0.6, 1.0), step(0.93, fR1));
float fFlick = 0.85 + 0.15 * sin(uTime * 3.0 + fR1 * 40.0) * step(0.97, fR2);
vec3 fEmis = fLitCol * min(fLit, 1.0) * fWin * (0.55 + 0.85 * fR1) * fFlick;`)
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.04 + 0.06 * fR1, fWin * (1.0 - fBlind));
roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.3, uWetness * fRoof);`)
    .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, fStyle < 0.5 ? 0.75 : 0.45, fWin * (1.0 - fBlind));`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += fEmis * uNight * 1.1 * (0.5 + 0.6 * ff.y);`)
    .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
#if defined( RE_IndirectSpecular )
  radiance *= 1.0 + mix(2.0, 0.6, fGround) * fWin * (1.0 - fBlind) + 3.0 * uWetness * fRoof;
#endif`);
};

// ---------------------------------------------------------------------------
// Дороги, тротуары, газоны, площади: разметка, плитка, лужи.
// aRoad = (тип, полос в одну сторону, полуширина/ex, ez). uv — локальные метры.
// ---------------------------------------------------------------------------
const roadHook: Hook = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
attribute vec4 aRoad;
varying vec4 vRoad;
varying vec2 vRUv;
varying vec3 vRWP;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
vRoad = aRoad;
vRUv = uv;
vRWP = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
uniform float uWetness;
uniform float uTime;
varying vec4 vRoad;
varying vec2 vRUv;
varying vec3 vRWP;
${NOISE_GLSL}
float lineMask(float d, float w) { float aa = fwidth(d) + 0.002; return 1.0 - smoothstep(w - aa, w + aa, d); }`)
    .replace('#include <color_fragment>', `#include <color_fragment>
float rT = floor(vRoad.x + 0.5);
vec2 ruv = vRUv;
vec2 wp = vRWP.xz;
float n1 = vnoise(wp * 0.9);
float n2 = vnoise(wp * 0.09);
float n3 = vnoise(wp * 5.0);
vec3 rCol;
float rRough = 0.88;
float rPuddleK = 1.0;
vec3 asph = vec3(0.085, 0.085, 0.09) * (0.82 + 0.36 * n2) * (0.9 + 0.2 * n3);
if (rT == 0.0 || rT == 3.0) {
  // Прямой участок дороги: u поперёк (со знаком), v вдоль.
  float lanes = vRoad.y; float hw = vRoad.z; float au = abs(ruv.x);
  rCol = asph;
  // Накатанные колеи темнее.
  float lanePos = fract(au / 3.5);
  rCol *= 1.0 - 0.1 * (lineMask(abs(lanePos - 0.25), 0.08) + lineMask(abs(lanePos - 0.75), 0.08));
  float dash = step(0.45, fract(ruv.y / 10.0));
  float mk = 0.0; vec3 mc = vec3(0.86);
  float center = rT == 3.0 ? lineMask(au, 0.6) : max(lineMask(abs(au - 0.16), 0.06), 0.0);
  if (rT == 3.0) { rCol = mix(rCol, vec3(0.32, 0.31, 0.3) * (0.8 + 0.3 * n1), center); }
  else { mk = center; mc = vec3(0.9, 0.66, 0.1); }
  for (int k = 1; k < 4; k++) {
    float fk = float(k);
    if (fk < lanes) mk = max(mk, lineMask(abs(au - fk * 3.5 - (rT == 3.0 ? 0.6 : 0.0)), 0.07) * dash);
  }
  float edgeL = lineMask(abs(au - (hw - 0.5)), 0.08);
  if (edgeL > mk && edgeL > 0.0) mc = vec3(0.86);
  mk = max(mk, edgeL);
  mk *= 0.7 + 0.3 * n1;
  rCol = mix(rCol, mc * (0.85 + 0.15 * n3), mk);
  rRough = mix(0.86, 0.6, mk);
} else if (rT == 1.0) {
  // Перекрёсток: зебры и стоп-линии. uv — локальные координаты от центра.
  float ex = vRoad.z, ez = vRoad.w;
  vec2 a = abs(ruv);
  rCol = asph;
  float zN = step(ez - 4.6, a.y) * step(a.y, ez - 0.9) * step(a.x, ex - 4.9) * step(0.5, fract(ruv.x / 1.3));
  float zE = step(ex - 4.6, a.x) * step(a.x, ex - 0.9) * step(a.y, ez - 4.9) * step(0.5, fract(ruv.y / 1.3));
  float stopN = lineMask(abs(a.y - (ez - 5.3)), 0.2) * step(a.x, ex - 5.0) * step(0.0, ruv.x * sign(ruv.y));
  float stopE = lineMask(abs(a.x - (ex - 5.3)), 0.2) * step(a.y, ez - 5.0) * step(0.0, -ruv.y * sign(ruv.x));
  float mk = clamp(zN + zE + stopN + stopE, 0.0, 1.0) * vRoad.y * (0.7 + 0.3 * n1);
  rCol = mix(rCol, vec3(0.86), mk);
  rRough = mix(0.86, 0.6, mk);
} else if (rT == 2.0) {
  // Тротуарная плитка.
  vec2 t = fract(wp / 1.5);
  float seam = max(lineMask(min(t.x, 1.0 - t.x), 0.03), lineMask(min(t.y, 1.0 - t.y), 0.03));
  rCol = vec3(0.44, 0.43, 0.41) * (0.85 + 0.25 * n2) * (0.93 + 0.12 * vhash(floor(wp / 1.5)));
  rCol *= 1.0 - 0.35 * seam;
  rRough = 0.8;
} else if (rT == 4.0) {
  // Газон.
  rCol = mix(vec3(0.10, 0.17, 0.05), vec3(0.19, 0.25, 0.08), n2) * (0.75 + 0.45 * n3);
  rRough = 0.95; rPuddleK = 0.3;
} else if (rT == 5.0) {
  // Площадь из каменных плит.
  vec2 t = fract(wp / 3.0);
  float seam = max(lineMask(min(t.x, 1.0 - t.x), 0.015), lineMask(min(t.y, 1.0 - t.y), 0.015));
  rCol = vec3(0.56, 0.53, 0.48) * (0.85 + 0.2 * vhash(floor(wp / 3.0))) * (0.9 + 0.15 * n1);
  rCol *= 1.0 - 0.4 * seam;
  rRough = 0.7;
} else if (rT == 6.0) {
  // Бетонные плиты (порт, парковки).
  vec2 t = fract(wp / 6.0);
  float seam = max(lineMask(min(t.x, 1.0 - t.x), 0.01), lineMask(min(t.y, 1.0 - t.y), 0.01));
  rCol = vec3(0.36, 0.355, 0.34) * (0.8 + 0.3 * n2) * (0.9 + 0.15 * n3);
  rCol *= 1.0 - 0.4 * seam;
  rRough = 0.85;
} else {
  // Грунт (стройка).
  rCol = mix(vec3(0.25, 0.19, 0.12), vec3(0.32, 0.26, 0.18), n2) * (0.8 + 0.3 * n3);
  rRough = 0.97; rPuddleK = 1.4;
}
// Дождь: потемнение, лужи с почти зеркальной поверхностью.
float pud = smoothstep(0.58, 0.72, vnoise(wp * 0.13) * 0.75 + n1 * 0.25) * uWetness * rPuddleK;
rCol *= mix(1.0, 0.62, uWetness);
rCol = mix(rCol, rCol * 0.45, clamp(pud, 0.0, 1.0));
rRough = mix(rRough, 0.28, uWetness);
rRough = mix(rRough, 0.03, clamp(pud, 0.0, 1.0));
diffuseColor.rgb = rCol;
float rPud = clamp(pud, 0.0, 1.0);`)
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = rRough;`)
    .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
#if defined( RE_IndirectSpecular )
  radiance *= 1.0 + 1.2 * uWetness + 3.5 * rPud;
#endif`);
};

// ---------------------------------------------------------------------------
// Рельеф: цвет из вершин (трава/песок/скалы) + шумовая детализация + мокрость.
// ---------------------------------------------------------------------------
const terrainHook: Hook = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
varying vec3 vTWP;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
vTWP = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
uniform float uWetness;
varying vec3 vTWP;
${NOISE_GLSL}`)
    .replace('#include <color_fragment>', `#include <color_fragment>
float tn = vnoise(vTWP.xz * 0.07) * 0.5 + vnoise(vTWP.xz * 0.6) * 0.3 + vnoise(vTWP.xz * 3.1) * 0.2;
diffuseColor.rgb *= 0.7 + 0.6 * tn;
diffuseColor.rgb *= 1.0 - 0.3 * uWetness;`)
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.45, uWetness * 0.7);`);
};

// ---------------------------------------------------------------------------
// Вода: анимированные нормали (сумма волн), отражение неба через карту окружения.
// ---------------------------------------------------------------------------
const waterHook: Hook = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
varying vec3 vWWP;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
vWWP = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
uniform float uTime;
uniform float uWetness;
varying vec3 vWWP;
${NOISE_GLSL}
vec2 waveGrad(vec2 p, float t) {
  vec2 g = vec2(0.0);
  vec2 d1 = normalize(vec2(1.0, 0.3)); float f1 = 0.21; g += d1 * cos(dot(p, d1) * f1 + t * 1.1) * 0.35;
  vec2 d2 = normalize(vec2(-0.4, 1.0)); float f2 = 0.37; g += d2 * cos(dot(p, d2) * f2 + t * 1.6) * 0.25;
  vec2 d3 = normalize(vec2(0.7, -0.8)); float f3 = 0.83; g += d3 * cos(dot(p, d3) * f3 + t * 2.3) * 0.12;
  vec2 d4 = normalize(vec2(-0.9, -0.2)); float f4 = 1.9; g += d4 * cos(dot(p, d4) * f4 + t * 3.1) * 0.06;
  return g;
}`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  float dist = length(vWWP - cameraPosition);
  float fade = 1.0 / (1.0 + dist * 0.004);
  vec2 g = waveGrad(vWWP.xz, uTime) * (0.35 + 0.25 * uWetness);
  g += (vec2(vnoise(vWWP.xz * 1.3 + uTime * 0.6), vnoise(vWWP.zx * 1.3 - uTime * 0.5)) - 0.5) * 0.25;
  vec3 wn = normalize(vec3(-g.x * fade, 1.0, -g.y * fade));
  normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
}`)
    .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
#if defined( RE_IndirectSpecular )
  radiance *= 5.0;
#endif`);
};

// ---------------------------------------------------------------------------
// Кузов машины: материал задаётся атрибутом aPart (краска/стекло/хром/фары...).
// Per-vehicle uniforms лежат в material.userData.
// ---------------------------------------------------------------------------
const carHook: Hook = (shader, mat) => {
  const ud = mat.userData as CarMaterialData;
  shader.uniforms.uPaint = ud.uPaint;
  shader.uniforms.uPaint2 = ud.uPaint2;
  shader.uniforms.uLights = ud.uLights;
  shader.uniforms.uSiren = ud.uSiren;
  shader.uniforms.uBurnt = ud.uBurnt;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
attribute float aPart;
varying float vPart;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
vPart = aPart;`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
uniform vec3 uPaint;
uniform vec3 uPaint2;
uniform vec4 uLights;
uniform vec2 uSiren;
uniform float uBurnt;
uniform float uWetness;
varying float vPart;`)
    .replace('#include <color_fragment>', `#include <color_fragment>
float cp = floor(vPart + 0.5);
vec3 cA = vec3(0.5); float cR = 0.5; float cM = 0.0; vec3 cE = vec3(0.0);
float sirenOn = uSiren.y;
float sirenPh = step(0.5, fract(uSiren.x));
if (cp == 0.0) { cA = uPaint; cR = 0.24; cM = 0.5; }
else if (cp == 1.0) { cA = vec3(0.025, 0.03, 0.035); cR = 0.04; cM = 0.65; }
else if (cp == 2.0) { cA = vec3(0.8); cR = 0.12; cM = 1.0; }
else if (cp == 3.0) { cA = vec3(0.025); cR = 0.75; cM = 0.0; }
else if (cp == 4.0) { cA = vec3(0.9); cR = 0.08; cE = vec3(1.0, 0.94, 0.82) * (0.08 + uLights.x * 7.0); }
else if (cp == 5.0) { cA = vec3(0.35, 0.02, 0.02); cR = 0.2; cE = vec3(1.0, 0.04, 0.02) * (0.12 + uLights.x * 0.9 + uLights.y * 5.0); }
else if (cp == 6.0) { cA = vec3(0.04); cR = 0.9; }
else if (cp == 7.0) { cA = vec3(0.3, 0.02, 0.02); cR = 0.2; cE = vec3(1.0, 0.03, 0.02) * sirenOn * sirenPh * 9.0; }
else if (cp == 8.0) { cA = vec3(0.02, 0.05, 0.3); cR = 0.2; cE = vec3(0.05, 0.2, 1.0) * sirenOn * (1.0 - sirenPh) * 9.0; }
else if (cp == 9.0) { cA = vec3(0.6, 0.3, 0.02); cR = 0.2; cE = vec3(1.0, 0.45, 0.02) * uLights.z * 4.0; }
else if (cp == 10.0) { cA = uPaint2; cR = 0.26; cM = 0.45; }
else if (cp == 11.0) { cA = vec3(0.12); cR = 0.45; cM = 0.8; }
else { cA = vec3(0.9, 0.9, 0.85); cR = 0.6; cE = vec3(1.0, 0.95, 0.6) * uLights.w * 3.0; }
cA = mix(cA, cA * 0.08 + vec3(0.015), uBurnt);
cE *= 1.0 - uBurnt;
diffuseColor.rgb = cA;`)
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(cR, 0.95, uBurnt);
roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.5, uWetness);`)
    .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = cM * (1.0 - uBurnt);`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += cE;`)
    .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
#if defined( RE_IndirectSpecular )
  radiance *= 3.5 * (1.0 - uBurnt);
#endif`);
};

/** Деревья: лёгкое покачивание кроны от ветра в вершинном шейдере. */
const foliageHook: Hook = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
uniform float uTime;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  // uv.y хранит высоту вершины над основанием дерева (работает и для слитой геометрии).
  float sway = max(uv.y - 1.5, 0.0) * 0.03;
  vec4 ip = vec4(0.0, 0.0, 0.0, 1.0);
  #ifdef USE_INSTANCING
    ip = instanceMatrix * ip;
  #endif
  vec4 wp0 = modelMatrix * vec4(position, 1.0);
  float ph = ip.x * 0.13 + ip.z * 0.07 + wp0.x * 0.05 + wp0.z * 0.04;
  transformed.x += sin(uTime * 1.3 + ph) * sway;
  transformed.z += cos(uTime * 1.1 + ph) * sway * 0.7;
}`);
};

const HOOKS: Partial<Record<MatKind, Hook>> = {
  facade: facadeHook,
  road: roadHook,
  terrain: terrainHook,
  water: waterHook,
  car: carHook,
  foliage: foliageHook,
};

export interface CarMaterialData {
  uPaint: { value: THREE.Color };
  uPaint2: { value: THREE.Color };
  /** x — фары, y — стоп-сигналы, z — поворотники/аварийка, w — фонарь такси. */
  uLights: { value: THREE.Vector4 };
  /** x — фаза мигалки, y — включена ли. */
  uSiren: { value: THREE.Vector2 };
  uBurnt: { value: number };
}

interface Entry { mat: THREE.Material; kind: MatKind }

/**
 * Реестр: хранит все материалы, чтобы при смене пресета (другое число каскадов)
 * заново подключить их к новому CSM.
 */
export class MaterialLib {
  private static entries = new Set<Entry>();
  private static csm: CSM | null = null;

  static setCSM(csm: CSM | null) {
    this.csm = csm;
    for (const e of this.entries) {
      this.apply(e);
      e.mat.needsUpdate = true;
    }
  }

  /** Регистрирует материал и патчит его шейдер под выбранный тип. */
  static register<T extends THREE.Material>(mat: T, kind: MatKind = 'standard'): T {
    const e: Entry = { mat, kind };
    this.entries.add(e);
    this.apply(e);
    return mat;
  }

  static unregister(mat: THREE.Material) {
    for (const e of this.entries) if (e.mat === mat) { this.entries.delete(e); break; }
  }

  private static apply(e: Entry) {
    const { mat, kind } = e;
    const lit = kind !== 'unlit';
    let csmHook: ((s: THREE.WebGLProgramParametersWithUniforms, r: THREE.WebGLRenderer) => void) | null = null;
    if (mat.defines) {
      delete mat.defines.USE_CSM;
      delete mat.defines.CSM_CASCADES;
      delete mat.defines.CSM_FADE;
    }
    if (lit && this.csm) {
      this.csm.setupMaterial(mat);
      csmHook = mat.onBeforeCompile;
    }
    const hook = HOOKS[kind];
    mat.onBeforeCompile = (shader, renderer) => {
      if (csmHook) csmHook.call(mat, shader, renderer);
      shader.uniforms.uTime = SharedUniforms.uTime;
      shader.uniforms.uNight = SharedUniforms.uNight;
      shader.uniforms.uWetness = SharedUniforms.uWetness;
      shader.uniforms.uFogSunDir = SharedUniforms.uFogSunDir;
      shader.uniforms.uFogSunColor = SharedUniforms.uFogSunColor;
      shader.uniforms.uFogHeight = SharedUniforms.uFogHeight;
      if (hook) hook(shader, mat);
    };
    // Без уникального ключа three.js переиспользовал бы программу другого типа.
    const cascades = this.csm ? this.csm.cascades : 0;
    mat.customProgramCacheKey = () => `${kind}|csm${lit ? cascades : 0}`;
  }

  /** Создаёт материал кузова машины с собственными uniform'ами. */
  static createCarMaterial(paint: THREE.ColorRepresentation, paint2: THREE.ColorRepresentation = 0xffffff) {
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.2 });
    const ud: CarMaterialData = {
      uPaint: { value: new THREE.Color(paint) },
      uPaint2: { value: new THREE.Color(paint2) },
      uLights: { value: new THREE.Vector4(0, 0, 0, 0) },
      uSiren: { value: new THREE.Vector2(0, 0) },
      uBurnt: { value: 0 },
    };
    m.userData = ud;
    return this.register(m, 'car');
  }

  static std(params: THREE.MeshStandardMaterialParameters, kind: MatKind = 'standard') {
    return this.register(new THREE.MeshStandardMaterial(params), kind);
  }

  static unlit(params: THREE.MeshBasicMaterialParameters) {
    return this.register(new THREE.MeshBasicMaterial(params), 'unlit');
  }
}
