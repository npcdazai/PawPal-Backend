import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { VerificationConfig } from '../config.ts';
import { logger } from '../log/logger.ts';
import type { NormalizedImage } from './imagePreprocess.ts';

const log = logger('face');

/** Length of Human's `faceres` descriptor (also the pgvector column size). */
export const EMBEDDING_DIMENSIONS = 1024;
/** A face smaller than this (px, shorter side) is too small to trust in a selfie. */
const MIN_SELFIE_FACE_PX = 96;

export interface FaceAnalysis {
  faceCount: number;
  /** Descriptor of the largest face, or null when none was found. */
  embedding: number[] | null;
  /** Shorter side of the largest face's box, in pixels. */
  faceSizePx: number;
  /** Degrees. */
  pose: { yaw: number; pitch: number; roll: number } | null;
  eyesClosed: boolean;
  /** Human's anti-spoof model: 0 = spoof … 1 = real. */
  antispoof: number | null;
  /** Human's liveness model: 0 = static … 1 = live. */
  liveness: number | null;
}

export interface FaceEngine {
  analyze(image: NormalizedImage): Promise<FaceAnalysis>;
  /** "tensorflow" (native) or "wasm". */
  backend(): Promise<string>;
}

/** Cosine similarity of two embeddings, −1 … 1 (1 = same direction). */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) throw new Error(`Embedding sizes differ (${a.length} vs ${b.length}).`);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

export type SelfieProblem = 'no_face' | 'multiple_faces' | 'face_too_small' | 'bad_pose' | 'eyes_closed' | 'spoof_suspected' | 'not_live';

/** Why a live selfie can't be used (empty when it can). */
export function selfieProblems(face: FaceAnalysis, config: VerificationConfig['face']): SelfieProblem[] {
  if (face.faceCount === 0 || !face.embedding) return ['no_face'];
  const problems: SelfieProblem[] = [];
  if (face.faceCount > 1) problems.push('multiple_faces');
  if (face.faceSizePx < MIN_SELFIE_FACE_PX) problems.push('face_too_small');
  if (face.pose && Math.max(Math.abs(face.pose.yaw), Math.abs(face.pose.pitch), Math.abs(face.pose.roll)) > config.maxPoseDegrees) {
    problems.push('bad_pose');
  }
  if (face.eyesClosed) problems.push('eyes_closed');
  if (face.antispoof !== null && face.antispoof < config.antispoofMin) problems.push('spoof_suspected');
  if (face.liveness !== null && face.liveness < config.livenessMin) problems.push('not_live');
  return problems;
}

/** The slice of Human's API used here (its bundled typings don't resolve through the package's exports map). */
interface HumanInstance {
  tf: {
    tensor3d(values: Uint8Array, shape: [number, number, number], dtype: 'int32'): unknown;
    dispose(tensor: unknown): void;
    getBackend(): string;
    io: { registerLoadRouter(router: (url: unknown) => unknown): void };
  };
  load(): Promise<void>;
  detect(input: unknown): Promise<{
    error: string | null;
    face: {
      id: number;
      box: [number, number, number, number];
      embedding?: number[];
      real?: number;
      live?: number;
      rotation?: { angle: { yaw: number; pitch: number; roll: number } } | null;
    }[];
    gesture: { face?: number; gesture: string }[];
  }>;
}

const require = createRequire(import.meta.url);
const HUMAN_ROOT = path.dirname(path.dirname(require.resolve('@vladmandic/human')));
const MODELS_URL = pathToFileURL(path.join(HUMAN_ROOT, 'models')).href + '/';
const degrees = (radians: number) => (radians * 180) / Math.PI;

/**
 * TFJS loads models with fetch(), which can't read file:// URLs in Node. Native
 * TensorFlow brings its own file loader; for WASM this one reads model.json and
 * its weight shards from disk.
 */
function fileModelLoader(url: unknown) {
  if (typeof url !== 'string' || !url.startsWith('file://')) return null;
  return {
    async load() {
      const jsonPath = fileURLToPath(url);
      const json = JSON.parse(await readFile(jsonPath, 'utf8')) as {
        weightsManifest: { paths: string[]; weights: unknown[] }[];
      } & Record<string, unknown>;
      const weightSpecs: unknown[] = [];
      const shards: Buffer[] = [];
      for (const group of json.weightsManifest) {
        weightSpecs.push(...group.weights);
        for (const shard of group.paths) shards.push(await readFile(path.join(path.dirname(jsonPath), shard)));
      }
      const weights = Buffer.concat(shards);
      return { ...json, weightSpecs, weightData: weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength) };
    },
  };
}

function humanConfig(backend: 'tensorflow' | 'wasm') {
  const wasmDir = path.join(path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm/package.json')), 'dist') + path.sep;
  return {
    backend,
    ...(backend === 'wasm' ? { wasmPath: wasmDir, wasmPlatformFetch: false } : {}),
    modelBasePath: MODELS_URL,
    debug: false,
    warmup: 'none',
    // Every image is independent: never reuse results from a "similar" previous frame.
    cacheSensitivity: 0,
    skipAllowed: false,
    face: {
      enabled: true,
      detector: { rotation: true, maxDetected: 5, minConfidence: 0.5, return: false },
      mesh: { enabled: true },
      iris: { enabled: true },
      description: { enabled: true },
      emotion: { enabled: false },
      attention: { enabled: false },
      antispoof: { enabled: true },
      liveness: { enabled: true },
    },
    body: { enabled: false },
    hand: { enabled: false },
    object: { enabled: false },
    segmentation: { enabled: false },
    gesture: { enabled: true },
  };
}

/** Native TensorFlow when it's installed and loads (Linux / Node 20–22), else WASM (anywhere). */
function loadHuman(preference: VerificationConfig['face']['backend']): { human: HumanInstance; backend: 'tensorflow' | 'wasm' } {
  type HumanModule = { Human?: new (config: unknown) => HumanInstance; default?: new (config: unknown) => HumanInstance };
  if (preference !== 'wasm') {
    try {
      const native = require(path.join(HUMAN_ROOT, 'dist', 'human.node.js')) as HumanModule;
      const Human = native.Human ?? native.default!;
      return { human: new Human(humanConfig('tensorflow')), backend: 'tensorflow' };
    } catch (error) {
      if (preference === 'tensorflow') throw error;
      log.warn('Native TensorFlow unavailable; using WASM', {
        reason: error instanceof Error ? error.message.split('\n')[0] : String(error),
      });
    }
  }
  const wasm = require(path.join(HUMAN_ROOT, 'dist', 'human.node-wasm.js')) as HumanModule;
  const Human = wasm.Human ?? wasm.default!;
  const human = new Human(humanConfig('wasm'));
  human.tf.io.registerLoadRouter(fileModelLoader);
  return { human, backend: 'wasm' };
}

/**
 * Face detection, pose, anti-spoof/liveness and 1024-d descriptors with
 * @vladmandic/human, entirely on this server. Loaded once on first use;
 * detections run one at a time because Human keeps per-call state.
 */
export function createHumanFaceEngine(config: VerificationConfig['face']): FaceEngine {
  let ready: Promise<{ human: HumanInstance; backend: string }> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const engine = () => {
    ready ??= (async () => {
      const loaded = loadHuman(config.backend);
      await loaded.human.load();
      log.debug('Human models loaded', { backend: loaded.human.tf.getBackend() });
      return loaded;
    })().catch((error: unknown) => {
      ready = null;
      throw error;
    });
    return ready;
  };

  async function detect(image: NormalizedImage): Promise<FaceAnalysis> {
    const { human } = await engine();
    const tensor = human.tf.tensor3d(new Uint8Array(image.rgb), [image.height, image.width, 3], 'int32');
    try {
      const result = await human.detect(tensor);
      if (result.error) throw new Error(`Face detection failed: ${result.error}`);
      const faces = [...result.face].sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3]);
      const main = faces[0];
      if (!main) {
        return { faceCount: 0, embedding: null, faceSizePx: 0, pose: null, eyesClosed: false, antispoof: null, liveness: null };
      }
      const gestures = result.gesture.filter((entry) => entry.face === main.id).map((entry) => entry.gesture);
      const angle = main.rotation?.angle;
      return {
        faceCount: faces.length,
        embedding: main.embedding?.length === EMBEDDING_DIMENSIONS ? Array.from(main.embedding) : null,
        faceSizePx: Math.round(Math.min(main.box[2], main.box[3])),
        pose: angle ? { yaw: degrees(angle.yaw), pitch: degrees(angle.pitch), roll: degrees(angle.roll) } : null,
        eyesClosed: gestures.includes('blink left eye') && gestures.includes('blink right eye'),
        antispoof: typeof main.real === 'number' ? main.real : null,
        liveness: typeof main.live === 'number' ? main.live : null,
      };
    } finally {
      human.tf.dispose(tensor);
    }
  }

  return {
    analyze(image) {
      const run = queue.then(() => detect(image));
      queue = run.catch(() => undefined);
      return run;
    },
    async backend() {
      return (await engine()).backend;
    },
  };
}
