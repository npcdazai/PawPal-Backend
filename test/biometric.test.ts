import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import sharp from 'sharp';
import { loadConfig } from '../src/config.ts';
import { cosineSimilarity, createHumanFaceEngine, selfieProblems, type FaceAnalysis } from '../src/services/biometricFaceService.ts';
import { normalizeImage } from '../src/services/imagePreprocess.ts';
import { HttpError } from '../src/http/errors.ts';

const face = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://unused' }).verification!.face;

const goodSelfie: FaceAnalysis = {
  faceCount: 1,
  embedding: [1, 0, 0],
  faceSizePx: 220,
  pose: { yaw: 4, pitch: -6, roll: 2 },
  eyesClosed: false,
  antispoof: 0.93,
  liveness: 0.88,
};

describe('biometrics', () => {
  test('cosine similarity', () => {
    assert.equal(cosineSimilarity([1, 2, 3], [2, 4, 6]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 5]), 0);
    assert.equal(cosineSimilarity([1, 1], [-1, -1]), -1);
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
    assert.throws(() => cosineSimilarity([1, 2], [1, 2, 3]));
  });

  test('a usable selfie: one face, big enough, facing the camera, eyes open, live', () => {
    assert.deepEqual(selfieProblems(goodSelfie, face), []);
    assert.deepEqual(selfieProblems({ ...goodSelfie, faceCount: 0, embedding: null }, face), ['no_face']);
    assert.deepEqual(
      selfieProblems({ ...goodSelfie, faceCount: 2, faceSizePx: 60, pose: { yaw: 40, pitch: 0, roll: 0 }, eyesClosed: true }, face),
      ['multiple_faces', 'face_too_small', 'bad_pose', 'eyes_closed']
    );
    assert.deepEqual(selfieProblems({ ...goodSelfie, antispoof: 0.2, liveness: 0.1 }, face), ['spoof_suspected', 'not_live']);
  });

  test('images are size-checked, re-encoded and stripped of metadata', async () => {
    const tagged = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#336699' } })
      .withMetadata({ exif: { IFD0: { Software: 'Adobe Photoshop 25.0' } } })
      .jpeg()
      .toBuffer();
    const image = await normalizeImage(tagged, 'The ID photo');
    assert.deepEqual([image.width, image.height], [1280, 853]);
    assert.equal(image.rgb.length, 1280 * 853 * 3);
    assert.deepEqual(image.warnings, ['exif_editor:photoshop']);
    assert.equal((await sharp(image.jpeg).metadata()).exif, undefined);

    await assert.rejects(normalizeImage(Buffer.from('not an image'), 'The selfie'), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.code, 'invalid_image');
      return true;
    });
    const tiny = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#fff' } }).png().toBuffer();
    await assert.rejects(normalizeImage(tiny, 'The selfie'), /too small/);
  });

  test('Human loads its models on this machine and finds no face in a blank photo', { timeout: 120_000 }, async () => {
    const engine = createHumanFaceEngine(face);
    const blank = await normalizeImage(
      await sharp({ create: { width: 800, height: 600, channels: 3, background: '#88aacc' } }).jpeg().toBuffer(),
      'test'
    );
    const result = await engine.analyze(blank);
    assert.equal(result.faceCount, 0);
    assert.equal(result.embedding, null);
    assert.ok(['wasm', 'tensorflow'].includes(await engine.backend()));
  });
});
