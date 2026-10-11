#!/usr/bin/env node
// Entry point for every PEKA hook. It must never break a session: any failure is logged
// to state/peka.log and the process still exits 0 with no output.
import fs from "node:fs";
import { contextFrom, handle } from "./lib/handlers.mjs";
import { log } from "./lib/state.mjs";

const event = process.argv[2] ?? "";
let ctx = null;
try {
  ctx = contextFrom(process.env);
  let input = null;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    // Empty or malformed input: nothing to do.
  }
  const out = handle(event, input, ctx);
  if (out) process.stdout.write(JSON.stringify(out));
} catch (err) {
  if (ctx) log(ctx.d, `${event}: ${err?.stack ?? err}`);
}
process.exit(0);
