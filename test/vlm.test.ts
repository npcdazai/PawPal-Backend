import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import { HttpError } from '../src/http/errors.ts';
import { createVlmKycService } from '../src/services/vlmKycService.ts';

const REPLY = {
  idDocument: {
    isGovernmentId: true,
    isPhysicalDocument: true,
    isUnaltered: true,
    presentationAttackSignals: [],
    tamperSignals: [],
    idType: 'PAN',
    countryCode: 'in',
    fullName: 'Alex Rivera',
    dob: '1994-03-18',
    idNumber: 'ABCDE1234F',
  },
  selfie: { isLiveCapture: true, singlePerson: true, presentationAttackSignals: [] },
};

/** A stand-in for Ollama's /v1/chat/completions that plays back `replies` in order. */
async function fakeOllama(replies: string[]) {
  const requests: { messages: { role: string; content: unknown }[]; response_format?: unknown; model: string }[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const content = replies[Math.min(requests.length - 1, replies.length - 1)];
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 0,
        model: 'qwen2.5vl:7b',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { url, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

const settings = (baseUrl: string) => ({ baseUrl, apiKey: 'ollama', model: 'qwen2.5vl:7b', timeoutMs: 5_000, shiftCheck: true });
const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe('open-weight VLM KYC service', () => {
  test('sends both photos as data URLs in JSON mode and reads the fenced reply', async () => {
    const ollama = await fakeOllama(['```json\n' + JSON.stringify(REPLY) + '\n```']);
    try {
      const audit = await createVlmKycService(settings(ollama.url)).auditIdAndSelfie(image, image);
      assert.equal(audit.idDocument.idType, 'PAN');
      assert.equal(audit.idDocument.countryCode, 'IN');
      const request = ollama.requests[0]!;
      assert.equal(request.model, 'qwen2.5vl:7b');
      assert.deepEqual(request.response_format, { type: 'json_object' });
      const parts = request.messages[1]!.content as { type: string; image_url?: { url: string } }[];
      assert.equal(parts.filter((part) => part.type === 'image_url').length, 2);
      assert.match(parts[1]!.image_url!.url, /^data:image\/jpeg;base64,/);
    } finally {
      await ollama.close();
    }
  });

  test('a malformed reply gets one corrective retry', async () => {
    const ollama = await fakeOllama(['{"idDocument": {"isGovernmentId": "maybe"}}', JSON.stringify(REPLY)]);
    try {
      const audit = await createVlmKycService(settings(ollama.url)).auditIdAndSelfie(image, image);
      assert.equal(audit.selfie.isLiveCapture, true);
      assert.equal(ollama.requests.length, 2);
      assert.match(String(ollama.requests[1]!.messages.at(-1)!.content), /didn't match the required JSON/);
    } finally {
      await ollama.close();
    }
  });

  test('two bad replies, or no server, become errors the app can show', async () => {
    const ollama = await fakeOllama(['not json at all']);
    try {
      await assert.rejects(createVlmKycService(settings(ollama.url)).checkLiveSelfie(image), (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.code, 'vlm_bad_reply');
        return true;
      });
    } finally {
      await ollama.close();
    }
    await assert.rejects(createVlmKycService(settings('http://127.0.0.1:9/v1')).checkLiveSelfie(image), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 503);
      return true;
    });
  });
});
