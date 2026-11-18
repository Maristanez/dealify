/** Shared enforcement and merchant disclosure for the free pilot. */
export function pilotLimits(env) {
  return {
    dailyTurns: Math.ceil(Math.min(10000, Math.max(1, Number(env.PILOT_DAILY_TURNS) || 500))),
    hourlyTurns: 30,
    dailySessions: 1000,
    minuteRequests: 90,
    messageCharacters: 2000,
  };
}
