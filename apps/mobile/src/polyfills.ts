// Runtime polyfills imported first at app entry (issue #383 M1). The shared client bridge
// (@rennet/client WsRennetBridge) generates request-correlation ids with `crypto.randomUUID`,
// which React Native's Hermes runtime does not provide. These ids are for correlation, not
// secrets, so a Math.random-based v4 shim is correct and needs no native module — it only fills
// the gap when the platform lacks the API (a device that already has crypto keeps its own).
const g = globalThis as { crypto?: { randomUUID?: () => string } };
if (!g.crypto) g.crypto = {};
if (typeof g.crypto.randomUUID !== "function") {
  g.crypto.randomUUID = (): string =>
    "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => {
      const n = Number(c);
      return (n ^ (Math.floor(Math.random() * 16) & (15 >> (n / 4)))).toString(16);
    });
}
