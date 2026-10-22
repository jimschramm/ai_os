import { describe, expect, it } from "vite-plus/test";

import {
  appendObservedClientAddress,
  bindDevProxyClientAddress,
  DEV_SERVER_BIND_HOST,
} from "./devProxy.ts";

describe("dev proxy client address", () => {
  it("binds the dev server to loopback and stamps the peer the proxy accepted", () => {
    expect(DEV_SERVER_BIND_HOST).toBe("127.0.0.1");

    const headers: string[] = [];
    let listener:
      | ((
          proxyReq: { setHeader(name: string, value: string): void },
          req: {
            readonly headers: { readonly [name: string]: string | readonly string[] | undefined };
            readonly socket: { readonly remoteAddress?: string | undefined };
          },
        ) => void)
      | undefined;
    bindDevProxyClientAddress({
      on(_event, next) {
        listener = next;
      },
    });
    listener?.(
      {
        setHeader(_name, value) {
          headers.push(value);
        },
      },
      {
        headers: { "x-forwarded-for": "127.0.0.1" },
        socket: { remoteAddress: "203.0.113.5" },
      },
    );

    expect(headers).toEqual(["127.0.0.1, 203.0.113.5"]);
    expect(appendObservedClientAddress(undefined, "203.0.113.5")).toBe("203.0.113.5");
    expect(appendObservedClientAddress(undefined, "127.0.0.1")).toBe("127.0.0.1");
  });
});
