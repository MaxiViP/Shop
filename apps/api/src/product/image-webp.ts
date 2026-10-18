// Header/container validation only; no pixel decoder. The private publisher
// performs full decode, and the registry binds these bytes to its SHA-256.
// https://developers.google.com/speed/webp/docs/riff_container
// https://datatracker.ietf.org/doc/html/rfc6386#section-19.1
export function webpDimensions(buffer: Buffer) {
  if (
    buffer.length < 20 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WEBP' ||
    buffer.readUInt32LE(4) !== buffer.length - 8
  )
    return null;
  let canvas: { width: number; height: number } | undefined;
  let pixels: { width: number; height: number } | undefined;
  let offset = 12;
  let chunks = 0;
  while (offset + 8 <= buffer.length && ++chunks <= 64) {
    const name = buffer.toString('ascii', offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length || (length % 2 && buffer[end] !== 0)) return null;
    if (name === 'ANIM' || name === 'ANMF') return null;
    if (name === 'VP8X') {
      if (offset !== 12 || length !== 10 || buffer[start]! & 2) return null;
      canvas = {
        width: buffer.readUIntLE(start + 4, 3) + 1,
        height: buffer.readUIntLE(start + 7, 3) + 1,
      };
    } else if (name === 'VP8 ') {
      if (
        pixels ||
        length < 10 ||
        buffer[start]! & 1 ||
        buffer.toString('hex', start + 3, start + 6) !== '9d012a'
      )
        return null;
      pixels = {
        width: buffer.readUInt16LE(start + 6) & 0x3fff,
        height: buffer.readUInt16LE(start + 8) & 0x3fff,
      };
    } else if (name === 'VP8L') {
      if (pixels || length < 5 || buffer[start] !== 0x2f) return null;
      const bits = buffer.readUInt32LE(start + 1);
      if (bits >>> 29) return null;
      pixels = {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    } else if (['EXIF', 'XMP ', 'ICCP'].includes(name)) {
      // v1 outputs must not contain copied source metadata.
      return null;
    }
    offset = end + (length % 2);
  }
  if (
    offset !== buffer.length ||
    !pixels ||
    !pixels.width ||
    !pixels.height ||
    (canvas &&
      (canvas.width !== pixels.width || canvas.height !== pixels.height))
  )
    return null;
  return pixels;
}
