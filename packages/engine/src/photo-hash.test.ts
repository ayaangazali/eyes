import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import { hashPhoto } from "./photo-hash.js";

const img = (f: (x: number, y: number) => number, q = 90) => {
  const w = 64;
  const data = Buffer.alloc(w * w * 4);
  for (let y = 0; y < w; y++)
    for (let x = 0; x < w; x++) data.fill(f(x, y), (y * w + x) * 4, (y * w + x) * 4 + 3);
  return new Uint8Array(jpeg.encode({ width: w, height: w, data }, q).data);
};
const dist = (a: string, b: string) => {
  let v = BigInt.asUintN(64, BigInt(a) ^ BigInt(b)),
    n = 0;
  for (; v; v >>= 1n) n += Number(v & 1n);
  return n;
};

describe("hashPhoto", () => {
  const gradient = (x: number, y: number) => (x * 3 + (y % 16) * 8) % 256;
  it("matches a recompressed copy and rejects a different photo", () => {
    const a = hashPhoto(img(gradient, 95))!;
    expect(dist(a.phash, hashPhoto(img(gradient, 40))!.phash)).toBeLessThanOrEqual(6);
    expect(dist(a.phash, hashPhoto(img((x, y) => (y * 4 + (x % 9) * 20) % 256))!.phash)).toBeGreaterThan(6);
  });
  it("does not fingerprint bytes that are not a JPEG", () => {
    expect(hashPhoto(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
