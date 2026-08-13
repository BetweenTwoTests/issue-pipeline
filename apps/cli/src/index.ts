#!/usr/bin/env node
import { Command } from "commander";
import { registerStatusCommand } from "./commands/status";
import { registerStartCommand } from "./commands/start";
import { registerResumeCommand } from "./commands/resume";
import { registerSkipCommand } from "./commands/skip";
import { registerAbortCommand } from "./commands/abort";
import { registerAnswerCommand } from "./commands/answer";

const program = new Command();
program.name("pipe").description("issue-pipeline control CLI");

registerStatusCommand(program);
registerStartCommand(program);
registerResumeCommand(program);
registerSkipCommand(program);
registerAbortCommand(program);
registerAnswerCommand(program);

program.parseAsync(process.argv);
