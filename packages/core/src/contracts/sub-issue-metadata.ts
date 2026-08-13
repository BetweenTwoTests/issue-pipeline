import { z } from "zod";

export const SubIssueMetadataSchema = z
  .object({
    parent: z.number().int().positive(),
    phase: z.number().int().positive(),
    base_branch: z.string().min(1),
  })
  .strict();

export type SubIssueMetadata = z.infer<typeof SubIssueMetadataSchema>;

const METADATA_RE = /<!--\s*pipeline:\s*(\{[\s\S]*?\})\s*-->/;

export function composeMetadataComment(metadata: SubIssueMetadata): string {
  return `<!-- pipeline: ${JSON.stringify(metadata)} -->`;
}

export function composeSubIssueBody(metadata: SubIssueMetadata, bodyMarkdown: string): string {
  return `${composeMetadataComment(metadata)}\n\n${bodyMarkdown}`;
}

/**
 * Never throws -- returns null on anything not matching, so a best-effort
 * status/resume read never crashes on a missing or hand-edited comment.
 */
export function parseSubIssueMetadata(body: string | null | undefined): SubIssueMetadata | null {
  if (!body) return null;
  const match = body.match(METADATA_RE);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    const result = SubIssueMetadataSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
