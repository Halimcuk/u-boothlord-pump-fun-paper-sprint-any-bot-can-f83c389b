// Second-Wave Sniper: a pump.fun paper-trading bot for agent-fun/replay/v2.
// Entry: "Pump.fun Paper Sprint: Any Bot Can Win" (u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the SDK
// shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte in vendor/.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
