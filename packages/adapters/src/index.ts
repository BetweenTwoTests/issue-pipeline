export function formatGreeting(name: string): string {
  return `Hello, ${name}!`;
}

export { run as runClaude, type ClaudeRunInput } from "./claude";
export { run as runCodex, type CodexRunInput } from "./codex";
export * from "./prompts";
