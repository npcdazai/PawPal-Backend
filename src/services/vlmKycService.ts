import OpenAI from 'openai';
import { z } from 'zod';
import type { VerificationConfig } from '../config.ts';
import { HttpError } from '../http/errors.ts';
import { logger } from '../log/logger.ts';

const log = logger('vlm');

export const ID_TYPES = ['AADHAAR', 'PAN', 'DRIVING_LICENSE', 'PASSPORT', 'VOTER_ID', 'NATIONAL_ID', 'OTHER'] as const;
export type IdType = (typeof ID_TYPES)[number];

const signals = z.array(z.string().max(200)).max(12).catch([]);
const nullableText = z.string().trim().max(200).nullable().catch(null);

const selfieAudit = z.object({
  isLiveCapture: z.boolean(),
  singlePerson: z.boolean().catch(true),
  presentationAttackSignals: signals,
});

const idAndSelfieAudit = z.object({
  idDocument: z.object({
    isGovernmentId: z.boolean(),
    isPhysicalDocument: z.boolean(),
    isUnaltered: z.boolean(),
    presentationAttackSignals: signals,
    tamperSignals: signals,
    idType: z.enum(ID_TYPES).catch('OTHER'),
    countryCode: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .transform((value) => value.toUpperCase())
      .nullable()
      .catch(null),
    fullName: nullableText,
    dob: nullableText,
    idNumber: nullableText,
  }),
  selfie: selfieAudit,
});

export type IdAndSelfieAudit = z.infer<typeof idAndSelfieAudit>;
export type SelfieAudit = z.infer<typeof selfieAudit>;

export interface VlmKycService {
  /** OCR + presentation-attack audit of a government ID and the enrolment selfie. */
  auditIdAndSelfie(idJpeg: Buffer, selfieJpeg: Buffer): Promise<IdAndSelfieAudit>;
  /** Quick presentation-attack check of a doorstep selfie. */
  checkLiveSelfie(selfieJpeg: Buffer): Promise<SelfieAudit>;
}

const SYSTEM_PROMPT = `You are a meticulous identity-document examiner for a pet-care marketplace.
You inspect photos for presentation attacks and tampering and you transcribe ID fields exactly.
You never guess: if a field is unreadable, use null. You reply with one JSON object and nothing else.`;

const ID_AND_SELFIE_PROMPT = `Image 1 should be a photo of a government ID card (Aadhaar, PAN, driving licence, passport, voter ID or another national ID).
Image 2 should be a live selfie of the same person taken just now with a phone camera.

Check image 1:
- isGovernmentId: is it a government-issued identity document?
- isPhysicalDocument: is it a photo of a physical card or page, NOT a photo of a phone/laptop screen (look for moiré patterns, pixel grids, screen bezels, glare typical of glass displays, UI elements) and NOT a printout or photocopy (paper texture, toner, cut edges)?
- isUnaltered: no signs of editing (mismatched fonts or spacing, misaligned text, pasted or replaced photo, blurred or smudged fields, inconsistent lighting on the portrait)?
- presentationAttackSignals / tamperSignals: short phrases naming what you saw (empty arrays if nothing).
- idType: one of AADHAAR, PAN, DRIVING_LICENSE, PASSPORT, VOTER_ID, NATIONAL_ID, OTHER.
- countryCode: ISO 3166-1 alpha-2 of the issuing country, or null.
- fullName, dob (as printed, prefer YYYY-MM-DD if unambiguous), idNumber (exactly as printed, including any X masking): or null when unreadable.

Check image 2:
- isLiveCapture: a real person photographed directly by a camera in a real environment, NOT a photo of a screen, a printed photo, a mask or a cut-out.
- singlePerson: exactly one person's face visible.
- presentationAttackSignals: short phrases naming any spoofing evidence (empty array if none).

Reply with JSON of exactly this shape:
{"idDocument":{"isGovernmentId":true,"isPhysicalDocument":true,"isUnaltered":true,"presentationAttackSignals":[],"tamperSignals":[],"idType":"AADHAAR","countryCode":"IN","fullName":"…","dob":"…","idNumber":"…"},"selfie":{"isLiveCapture":true,"singlePerson":true,"presentationAttackSignals":[]}}`;

const SELFIE_PROMPT = `This should be a live selfie of a dog walker taken just now at a customer's door with a phone camera.
- isLiveCapture: a real person photographed directly by a camera in a real environment, NOT a photo of a screen, a printed photo, a mask or a cut-out.
- singlePerson: exactly one person's face visible.
- presentationAttackSignals: short phrases naming any spoofing evidence (empty array if none).
Reply with JSON of exactly this shape: {"isLiveCapture":true,"singlePerson":true,"presentationAttackSignals":[]}`;

const dataUrl = (jpeg: Buffer) => `data:image/jpeg;base64,${jpeg.toString('base64')}`;

/** Pulls the JSON object out of a reply, tolerating ```json fences some models add. */
function extractJson(reply: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(reply);
  const body = (fenced?.[1] ?? reply).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return JSON.parse(start >= 0 && end > start ? body.slice(start, end + 1) : body);
}

/**
 * Open-weight vision model (Qwen2.5-VL by default) behind any OpenAI-compatible
 * endpoint. Replies are validated with zod; one corrective retry is made when
 * the model returns malformed JSON.
 */
export function createVlmKycService(config: VerificationConfig['vlm']): VlmKycService {
  const client = new OpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey, timeout: config.timeoutMs, maxRetries: 1 });

  async function ask<T>(schema: z.ZodType<T>, prompt: string, images: Buffer[]): Promise<T> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...images.map((jpeg) => ({ type: 'image_url' as const, image_url: { url: dataUrl(jpeg) } })),
        ],
      },
    ];

    let lastProblem = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let reply: string;
      const started = Date.now();
      try {
        const completion = await client.chat.completions.create({
          model: config.model,
          messages,
          temperature: 0,
          max_tokens: 800,
          response_format: { type: 'json_object' },
        });
        reply = completion.choices[0]?.message?.content ?? '';
        log.info('Model replied', { model: config.model, images: images.length, try: attempt + 1, ms: Date.now() - started });
      } catch (error) {
        log.error('Model request failed', { model: config.model, ms: Date.now() - started, error });
        throw new HttpError(503, 'vlm_unavailable', 'Document checks are busy right now. Try again in a minute.');
      }

      try {
        const parsed = schema.safeParse(extractJson(reply));
        if (parsed.success) return parsed.data;
        lastProblem = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
      } catch (error) {
        lastProblem = error instanceof Error ? error.message : 'not JSON';
      }
      log.warn('Model reply didn’t match the schema; asking again', { problem: lastProblem });
      messages.push(
        { role: 'assistant', content: reply },
        { role: 'user', content: `That reply didn't match the required JSON (${lastProblem}). Reply with only the corrected JSON object.` }
      );
    }
    log.error('Model reply unusable after a retry', { problem: lastProblem });
    throw new HttpError(502, 'vlm_bad_reply', 'We couldn’t read the document check. Retake the photos and try again.');
  }

  return {
    auditIdAndSelfie: (idJpeg, selfieJpeg) => ask(idAndSelfieAudit, ID_AND_SELFIE_PROMPT, [idJpeg, selfieJpeg]),
    checkLiveSelfie: (selfieJpeg) => ask(selfieAudit, SELFIE_PROMPT, [selfieJpeg]),
  };
}
