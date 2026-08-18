import { formatGreeting } from "@issue-pipeline/adapters";

export async function greet(name: string): Promise<string> {
  return formatGreeting(name);
}

export * from "./config";
export * from "./agents";
export * from "./tracker";
export * from "./tracker-sync";
export * from "./github";
export * from "./git";
export * from "./gates";
