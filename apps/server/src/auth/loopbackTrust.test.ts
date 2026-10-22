import { describe, expect, it } from "vite-plus/test";

import { evaluateLoopbackTrust, isLoopbackAddress } from "./loopbackTrust.ts";

const trusted = {
  trustLoopback: true,
  bindHost: undefined as string | undefined,
  remoteAddress: "127.0.0.1",
  forwardedFor: undefined as string | undefined,
  forwarded: undefined as string | undefined,
  host: "127.0.0.1:13773",
  origin: undefined as string | undefined,
};

describe("evaluateLoopbackTrust", () => {
  it("accepts loopback peers, including the whole 127/8 and IPv4-mapped ::1", () => {
    expect(evaluateLoopbackTrust(trusted)).toEqual({ ok: true });
    expect(
      evaluateLoopbackTrust({ ...trusted, remoteAddress: "::ffff:127.8.8.8", host: "localhost" }),
    ).toEqual({ ok: true });
    expect(
      evaluateLoopbackTrust({
        ...trusted,
        remoteAddress: "::1",
        host: "[::1]:13773",
        origin: "http://[::1]:5733",
      }),
    ).toEqual({ ok: true });
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackAddress("::ffff:192.168.1.10")).toBe(false);
  });

  it("accepts a loopback peer when the server listens on every interface", () => {
    expect(evaluateLoopbackTrust({ ...trusted, bindHost: "0.0.0.0" })).toEqual({ ok: true });
    expect(evaluateLoopbackTrust({ ...trusted, bindHost: undefined })).toEqual({ ok: true });
  });

  it("accepts a loopback bind that did not report a peer, and rejects other peers", () => {
    expect(
      evaluateLoopbackTrust({ ...trusted, bindHost: "127.0.0.1", remoteAddress: undefined }),
    ).toEqual({ ok: true });
    expect(
      evaluateLoopbackTrust({ ...trusted, bindHost: "127.0.0.1", remoteAddress: "10.0.0.8" }),
    ).toEqual({ ok: false, reason: "not-loopback" });
    expect(
      evaluateLoopbackTrust({ ...trusted, bindHost: "0.0.0.0", remoteAddress: undefined }),
    ).toEqual({ ok: false, reason: "not-loopback" });
  });

  it("rejects proxied loopback requests and foreign host or origin names", () => {
    expect(evaluateLoopbackTrust({ ...trusted, trustLoopback: false })).toEqual({
      ok: false,
      reason: "disabled",
    });
    expect(evaluateLoopbackTrust({ ...trusted, remoteAddress: "192.168.1.10" })).toEqual({
      ok: false,
      reason: "not-loopback",
    });
    expect(evaluateLoopbackTrust({ ...trusted, forwardedFor: "1.2.3.4" })).toEqual({
      ok: false,
      reason: "forwarded",
    });
    expect(evaluateLoopbackTrust({ ...trusted, forwardedFor: "127.0.0.1, 203.0.113.5" })).toEqual({
      ok: false,
      reason: "forwarded",
    });
    expect(evaluateLoopbackTrust({ ...trusted, forwardedFor: "127.0.0.1" })).toEqual({
      ok: true,
    });
    expect(evaluateLoopbackTrust({ ...trusted, forwarded: "for=1.2.3.4" })).toEqual({
      ok: false,
      reason: "forwarded",
    });
    expect(evaluateLoopbackTrust({ ...trusted, host: "evil.example" })).toEqual({
      ok: false,
      reason: "bad-host",
    });
    expect(evaluateLoopbackTrust({ ...trusted, origin: "https://evil.example" })).toEqual({
      ok: false,
      reason: "bad-origin",
    });
    expect(
      evaluateLoopbackTrust({
        ...trusted,
        host: "localhost:13773",
        origin: "http://127.0.0.1:5733",
      }),
    ).toEqual({ ok: true });
  });
});
