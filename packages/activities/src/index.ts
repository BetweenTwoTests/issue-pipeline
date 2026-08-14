import { formatGreeting } from "@issue-pipeline/adapters";

export async function greet(name: string): Promise<string> {
  return formatGreeting(name);
}

export * from "./config";
export * from "./agents";
export * from "./github";
export * from "./git";
export * from "./gates";
export * from "./projection-db";
