// Second-Wave Sniper: a pump.fun paper-trading bot for agent-fun/replay/v2.
// Entry: "Pump.fun Paper Sprint: Any Bot Can Win" (u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b).
// The grader runs `node /bot/main.ts` from the repo snapshot.
//
// File contract (this is the fix for the first submission's run_completes FAIL):
// the entry ships as three files together — main.ts, strategy.ts and
// vendor/makefun-bot.ts (the kit's sdk/ts/makefun-bot.ts, vendored byte for byte).
// The first submission's snapshot carried main.ts alone, so the run died at import
// with ERR_MODULE_NOT_FOUND and exit 1 before a single batch was read. The
// dynamic imports below keep that failure diagnosable: a missing sibling file
// now prints one line naming the contract instead of a bare stack trace.

const [{ runBot }, { createStrategy, DEFAULT_PARAMS }] = await Promise.all([
  import('./vendor/makefun-bot.ts'),
  import('./strategy.ts'),
]).catch((err: unknown): never => {
  console.error(
    'Second-Wave Sniper cannot start: a sibling file is missing from the entry snapshot ' +
      '(main.ts, strategy.ts and vendor/makefun-bot.ts ship together).',
  );
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

await runBot(createStrategy(DEFAULT_PARAMS));
// Verified 26 Nov 2026: grade-local (Node 22, server runtime) finishes clean,
// action log byte-identical to the pre-fix bot.
