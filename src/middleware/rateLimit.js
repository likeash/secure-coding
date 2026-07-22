class MemoryRateLimiter {
  constructor({ windowMs, max, blockMs = 0 }) {
    this.windowMs = windowMs;
    this.max = max;
    this.blockMs = blockMs;
    this.entries = new Map();
  }

  check(key, now = Date.now()) {
    const current = this.entries.get(key);
    if (current?.blockedUntil > now) return false;
    if (!current || now - current.startedAt >= this.windowMs) {
      this.entries.set(key, { startedAt: now, count: 1, blockedUntil: 0 });
      return true;
    }
    current.count += 1;
    if (current.count > this.max) {
      current.blockedUntil = this.blockMs ? now + this.blockMs : current.startedAt + this.windowMs;
      return false;
    }
    return true;
  }

  middleware(keyFn = (req) => req.ip) {
    return (req, res, next) => {
      if (!this.check(keyFn(req))) return res.status(429).render('error', { title: '요청 제한', message: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
      next();
    };
  }

  clear() {
    this.entries.clear();
  }
}

module.exports = { MemoryRateLimiter };
