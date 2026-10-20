// Outbound rate limiting: sliding-window counter (in-memory; resets on process
// restart — acceptable, it guards against runaway loops spamming mail).
// Hourly window only: 10 mails/hour (configurable).

export class RateLimiter {
  constructor({ perHour = 10, now = Date.now } = {}) {
    this.perHour = perHour;
    this.now = now;
    this.events = [];
  }

  /** Returns {ok:true} or {ok:false, reason}. On success, consumes one slot. */
  allow(t = this.now()) {
    this.events = this.events.filter((ts) => t - ts < 3600e3);
    if (this.events.length >= this.perHour) {
      return { ok: false, reason: `Outbound hourly rate limit reached (${this.perHour} mails/hour) — suspected infinite loop, send rejected` };
    }
    this.events.push(t);
    return { ok: true };
  }
}
