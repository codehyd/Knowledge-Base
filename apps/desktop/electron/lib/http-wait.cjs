/**
 * HTTP 就绪探测（API / Vite）。
 */

const http = require("http");

function waitForHttp(url, timeoutMs = 60000, label = "服务", { okStatuses } = {}) {
  const started = Date.now();
  const allow =
    Array.isArray(okStatuses) && okStatuses.length ? new Set(okStatuses) : null;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        const code = res.statusCode || 0;
        const ok = allow ? allow.has(code) : code > 0 && code < 500;
        if (ok) {
          resolve(true);
          return;
        }
        retry();
      });
      req.on("error", retry);
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`${label}未在 ${timeoutMs}ms 内就绪：${url}`));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

module.exports = { waitForHttp };
