import sharp from 'sharp';
import { webpDimensions } from './image-webp.js';

describe('bounded WebP header reader', () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const)(
    'reads actual dimensions: lossless=%s alpha=%s',
    async (lossless, alpha) => {
      const buffer = await sharp({
        create: {
          width: 123,
          height: 87,
          channels: alpha ? 4 : 3,
          background: { r: 20, g: 40, b: 60, alpha: alpha ? 0.5 : 1 },
        },
      })
        .webp({ lossless })
        .toBuffer();
      expect(webpDimensions(buffer)).toEqual({ width: 123, height: 87 });
    },
  );

  it.each(['signature', 'length', 'chunk', 'frame', 'truncated'] as const)(
    'rejects corrupt %s without decoding pixels',
    async (kind) => {
      const buffer = await sharp({
        create: { width: 192, height: 144, channels: 3, background: 'red' },
      })
        .webp()
        .toBuffer();
      const altered = Buffer.from(buffer);
      if (kind === 'signature') altered.write('HTML', 0);
      if (kind === 'length') altered.writeUInt32LE(0, 4);
      if (kind === 'chunk') altered.writeUInt32LE(0xffffffff, 16);
      if (kind === 'frame') altered[23] = 0;
      expect(
        webpDimensions(
          kind === 'truncated' ? altered.subarray(0, 21) : altered,
        ),
      ).toBeNull();
    },
  );

  it('rejects animation flags and metadata in v1 derivatives', async () => {
    const buffer = await sharp({
      create: {
        width: 80,
        height: 40,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0.5 },
      },
    })
      .webp()
      .toBuffer();
    expect(buffer.toString('ascii', 12, 16)).toBe('VP8X');
    const animated = Buffer.from(buffer);
    animated[20] = animated[20]! | 2;
    expect(webpDimensions(animated)).toBeNull();
    const metadata = await sharp(buffer)
      .withExif({ IFD0: { Copyright: 'fixture' } })
      .webp()
      .toBuffer();
    expect(webpDimensions(metadata)).toBeNull();
  });
});
