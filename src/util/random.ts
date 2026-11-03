import { createHash } from "node:crypto";

export const STREAM_PURPOSES = ["plan", "spec", "options", "layout"] as const;
export type StreamPurpose = (typeof STREAM_PURPOSES)[number];

export interface StreamDescriptor {
  readonly protocolVersion: string;
  readonly rootSeed: string;
  readonly slotId: string;
  readonly purpose: StreamPurpose;
}

const SEED_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function deriveStreamSeed(descriptor: StreamDescriptor): string {
  const payload = JSON.stringify([
    descriptor.protocolVersion,
    descriptor.rootSeed,
    descriptor.slotId,
    descriptor.purpose,
  ]);
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export class HashCounterPrng {
  private readonly seed: Buffer;
  private counter = 0;

  constructor(seedHex: string) {
    if (!SEED_HEX_PATTERN.test(seedHex)) {
      throw new Error("PRNG seed must be a 32-byte lowercase hexadecimal string");
    }
    this.seed = Buffer.from(seedHex, "hex");
  }

  nextUint32(): number {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(this.counter));
    this.counter += 1;
    const digest = createHash("sha256")
      .update(Buffer.concat([this.seed, counter]))
      .digest();
    return digest.readUInt32BE(0);
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x100000000) {
      throw new RangeError(`maxExclusive must be an integer between 1 and 2^32, received ${maxExclusive}`);
    }
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    for (;;) {
      const value = this.nextUint32();
      if (value < limit) {
        return value % maxExclusive;
      }
    }
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swapIndex = this.nextInt(index + 1);
      const current = copy[index] as T;
      copy[index] = copy[swapIndex] as T;
      copy[swapIndex] = current;
    }
    return copy;
  }
}

export function createStream(descriptor: StreamDescriptor): HashCounterPrng {
  return new HashCounterPrng(deriveStreamSeed(descriptor));
}
