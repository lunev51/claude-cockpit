// Точка входа модуля аватара: сцена three.js + загрузка VRM 1.0,
// связывает idle-анимации, липсинк и эмоции в один render-цикл.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

import { IdleAnimator } from './idle.js';
import { LipSync } from './lipsync.js';
import { EmotionController } from './emotions.js';

/**
 * Инициализирует 3D-аватар в контейнере.
 * @param {HTMLElement} container — куда вставить canvas
 * @param {object} opts — { vrmUrl, side, widthPercent, cameraFov, lookAtCamera }
 * @returns {Promise<object>} хэндл { vrm, setVisible, setEmotion, setMouth, lipsync, dispose }
 */
export async function initAvatar(container, opts = {}) {
  const fov = opts.cameraFov ?? 22;

  // --- рендерер ---
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setSize(container.clientWidth || 1, container.clientHeight || 1);
  container.appendChild(renderer.domElement);

  // Диагностика потери WebGL-контекста (например, после display:none).
  renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    console.error('[dbg-avatar] WebGL context LOST');
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    console.error('[dbg-avatar] WebGL context restored');
  });

  // --- сцена и камера ---
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    fov,
    (container.clientWidth || 1) / (container.clientHeight || 1),
    0.1,
    20,
  );
  // Позиция камеры будет вычислена по костям после загрузки VRM (см. ниже).

  // --- свет: тёплый ключевой + мягкая заливка ---
  // three r155+ использует физически корректные интенсивности (старые × π = 4.4/1.9
  // оказалось пересветом для MToon — подобрано визуально).
  const keyLight = new THREE.DirectionalLight(0xfff1e0, 2.6);
  keyLight.position.set(0.6, 1.8, 1.2); // спереди-сверху-сбоку
  scene.add(keyLight);
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x444466, 1.1));

  // --- загрузка VRM ---
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(opts.vrmUrl);
  /** @type {import('@pixiv/three-vrm').VRM} */
  const vrm = gltf.userData.vrm;

  // Оптимизации из three-vrm v3 (combineSkeletons заменил removeUnnecessaryJoints)
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);

  // three-vrm нормализует VRM 1.0 лицом в +Z — камера на +Z видит лицо;
  // для VRM 0.x применять VRMUtils.rotateVRM0(vrm).
  scene.add(vrm.scene);

  // --- A-поза: rest-поза VRM — это T-pose (руки раскинуты), опускаем руки ---
  // Модель лицом в +Z: левая рука вдоль +X (опускается отрицательным Z-поворотом).
  const pose = [
    ['leftUpperArm', -1.15], ['rightUpperArm', 1.15],   // ~66° вниз
    ['leftLowerArm', -0.2], ['rightLowerArm', 0.2],     // лёгкий сгиб в локте
  ];
  for (const [bone, rz] of pose) {
    const node = vrm.humanoid?.getNormalizedBoneNode(bone);
    if (node) node.rotation.z = rz;
  }

  // --- кадрирование по костям ---
  vrm.scene.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const head = vrm.humanoid?.getNormalizedBoneNode('head');
  const hips = vrm.humanoid?.getNormalizedBoneNode('hips');
  if (head && hips) {
    const headY = head.getWorldPosition(v).y;
    const hipsY = hips.getWorldPosition(v).y;
    // Видимый диапазон по вертикали: кадр ровно от bottomY до topY.
    // Камера без наклона (по центру диапазона) — голова обрезаться не может.
    const topY = headY + 0.13 + 0.12;  // макушка + воздух сверху (больше воздух → модель ниже)
    const bottomY = hipsY - 0.02;
    const targetY = (topY + bottomY) / 2;
    const span = topY - bottomY;
    const dist = (span / 2) / Math.tan(THREE.MathUtils.degToRad(fov) / 2);
    camera.position.set(0, targetY, dist);
    camera.lookAt(0, targetY, 0);
  } else {
    // fallback: прежние константы (fov=22, dist≈1.6)
    camera.position.set(0, 1.25, 1.6);
    camera.lookAt(0, 1.15, 0);
  }

  // Взгляд в камеру
  if (opts.lookAtCamera && vrm.lookAt) {
    vrm.lookAt.target = camera;
  }

  // --- подсистемы ---
  const idle = new IdleAnimator(vrm);
  const lipsync = new LipSync(vrm);
  const emotions = new EmotionController(vrm);

  // --- render-цикл; vrm.update() строго ПОСЛЕ всех setValue ---
  const clock = new THREE.Clock();
  const renderLoop = () => {
    const delta = clock.getDelta();
    idle.update(delta);
    lipsync.update(delta);
    emotions.update(delta);
    vrm.update(delta); // применяет expressions / lookAt / springBone
    renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(renderLoop);

  // --- ресайз под контейнер ---
  const resizeObserver = new ResizeObserver(() => {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  resizeObserver.observe(container);

  return {
    vrm,
    lipsync,

    /** Плавная смена эмоции (кроссфейд ~0.4с) */
    setEmotion(name, weight = 1) {
      emotions.set(name, weight);
    },

    /** Показать/скрыть аватар; в скрытом состоянии render-цикл остановлен (экономия GPU) */
    setVisible(visible) {
      const v = Boolean(visible);
      console.error(`[dbg-avatar] setVisible(${v}) ctxLost=${renderer.getContext()?.isContextLost?.() ?? '?'}`);
      renderer.domElement.style.display = v ? '' : 'none';
      renderer.setAnimationLoop(v ? renderLoop : null);
      if (v) {
        clock.getDelta(); // сброс дельты, чтобы не было скачка анимации
        // Принудительный кадр + ресайз: после display:none размеры могли обнулиться.
        const w = container.clientWidth || 1;
        const h = container.clientHeight || 1;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.render(scene, camera);
      }
    },

    /** Прямой драйв рта 0..1 (визема 'aa'), минуя анализатор */
    setMouth(value) {
      vrm.expressionManager?.setValue('aa', THREE.MathUtils.clamp(value, 0, 1));
    },

    /** Полная очистка ресурсов */
    dispose() {
      renderer.setAnimationLoop(null);
      resizeObserver.disconnect();
      lipsync.stop();
      VRMUtils.deepDispose(vrm.scene);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
