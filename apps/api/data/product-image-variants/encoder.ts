import { fork } from 'node:child_process';
import { z } from 'zod';
import type { ImageVariants } from '../../src/product/image-variants.js';

const resultSchema = z.strictObject({
  profile: z.literal('v1'),
  source: z.strictObject({
    format: z.enum(['jpeg', 'png', 'webp']),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    bytes: z
      .number()
      .int()
      .positive()
      .max(5 * 1024 * 1024),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .length(64),
  }),
  variants: z
    .array(
      z.strictObject({
        sizes: z
          .array(z.union([z.literal(192), z.literal(384), z.literal(640)]))
          .min(1)
          .max(3),
        buffer: z
          .instanceof(Buffer)
          .refine((buffer) => buffer.length <= 2 * 1024 * 1024),
        width: z.number().int().positive().max(640),
        height: z.number().int().positive().max(640),
        bytes: z
          .number()
          .int()
          .positive()
          .max(2 * 1024 * 1024),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .length(64),
      }),
    )
    .min(1)
    .max(3),
});
export class ImageJobError extends Error {
  constructor(
    readonly code: 'TIMEOUT' | 'MEMORY_LIMIT' | 'WORKER' | 'INVALID_SOURCE',
  ) {
    super('Supervised image job failed: ' + code);
  }
}
export interface WorkerUsage {
  peakRss: number;
  cpuMs: number;
}

export function supervisedEncode(
  source: Buffer,
  usage: (value: WorkerUsage) => void = () => {},
  budget = { timeoutMs: 30_000, rssBytes: 512 * 1024 * 1024 },
): Promise<ImageVariants> {
  return new Promise((resolve, reject) => {
    const child = fork(new URL('./worker.ts', import.meta.url), [], {
      execArgv: ['--import', 'tsx'],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      // The generator needs no application credentials or database environment.
      env: {
        SystemRoot: process.env.SystemRoot,
        PATH: process.env.PATH,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        UV_THREADPOOL_SIZE: '1',
        TSX_DISABLE_CACHE: '1',
      },
    });
    let result: ImageVariants | undefined;
    let failure: ImageJobError | undefined;
    const stop = (code: ImageJobError['code']) => {
      failure ??= new ImageJobError(code);
      child.kill('SIGKILL');
    };
    const timeout = setTimeout(() => stop('TIMEOUT'), budget.timeoutMs);
    child.on('error', () => stop('WORKER'));
    child.on('message', (message: unknown) => {
      const envelope = z
        .discriminatedUnion('type', [
          z.strictObject({
            type: z.literal('usage'),
            peakRss: z.number().nonnegative(),
            cpuMs: z.number().nonnegative(),
          }),
          z.strictObject({ type: z.literal('result'), result: resultSchema }),
          z.strictObject({ type: z.literal('invalid') }),
        ])
        .safeParse(message);
      if (!envelope.success) return stop('WORKER');
      const value = envelope.data;
      if (value.type === 'usage') {
        usage({ peakRss: value.peakRss, cpuMs: value.cpuMs });
        if (value.peakRss > budget.rssBytes) stop('MEMORY_LIMIT');
      } else if (value.type === 'result') result = value.result;
      else failure = new ImageJobError('INVALID_SOURCE');
    });
    // Never release the storage lock/start a replacement decoder before child exit.
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (failure) reject(failure);
      else if (code !== 0 || !result) reject(new ImageJobError('WORKER'));
      else resolve(result);
    });
    child.send({ source }, (error) => {
      if (error) stop('WORKER');
    });
  });
}
