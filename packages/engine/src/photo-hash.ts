import { createHash } from "node:crypto";
import jpeg from "jpeg-js";

// A perceptual match is Hamming distance <= this out of 64 bits. 6 survives recompression and
// small resizes; unrelated photos of the same place sit around 20+.
export const PHOTO_PHASH_MAX_DISTANCE = 6;

export type PhotoHash = { sha256: string; phash: string };

/** SHA-256 plus dHash (9x8 grey grid by box average, one bit per left>right step). Null when the bytes are not a decodable JPEG: only real photos are fingerprinted. */
export function hashPhoto(bytes: Uint8Array): PhotoHash | null {
  try {
    const { width, height, data } = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: false,
      maxResolutionInMP: 64,
      maxMemoryUsageInMB: 512,
    });
    const grid: number[] = [];
    for (let gy = 0; gy < 8; gy++) {
      for (let gx = 0; gx < 9; gx++) {
        const x0 = Math.floor((gx * width) / 9);
        const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / 9));
        const y0 = Math.floor((gy * height) / 8);
        const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / 8));
        let sum = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * width + x) * 3;
            sum += 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
          }
        }
        grid.push(sum / ((x1 - x0) * (y1 - y0)));
      }
    }
    let bits = 0n;
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++) bits = (bits << 1n) | (grid[r * 9 + c]! > grid[r * 9 + c + 1]! ? 1n : 0n);
    return {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      phash: BigInt.asIntN(64, bits).toString(),
    };
  } catch {
    return null;
  }
}
