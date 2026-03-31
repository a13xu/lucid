import { z } from "zod";
import { compressTextSemantic } from "../compression/semantic.js";

export const CompressTextSchema = z.object({
  text: z.string().min(1).describe("Text to compress"),
  ratio: z.number().min(0.1).max(0.9).optional().describe(
    "Target compression ratio: 0.3 = keep 30%, 0.5 = keep 50% (default: 0.5)"
  ),
  min_length: z.number().int().optional().describe(
    "Skip compression for texts shorter than this in chars (default: 300)"
  ),
});

export async function handleCompressText(
  args: z.infer<typeof CompressTextSchema>
): Promise<string> {
  const result = await compressTextSemantic(
    args.text,
    args.ratio ?? 0.5,
    args.min_length ?? 300
  );

  return JSON.stringify({
    compressed: result.compressed,
    original_length: result.originalLength,
    compressed_length: result.compressedLength,
    ratio_kept: result.ratio,
    method: result.method,
    tokens_saved: Math.ceil((result.originalLength - result.compressedLength) / 4),
  }, null, 2);
}
