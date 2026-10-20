import { EventEmitter } from "node:events";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket as NodeWebSocket } from "ws";
import {
  HEAD_PENDING_HEADER,
  HEAD_PENDING_INTERVAL_MS,
  decodeFrame,
  encodeFrame,
  type Frame,
} from "@bb/tunnel-contract";
import { TunnelSession, acceptsHeadPending } from "../src/session.js";

class FakeTunnel extends EventEmitter {
  readonly readyState = 1;
  readonly frames: Frame[] = [];
  readonly terminate = vi.fn();

  send(data: Uint8Array | string): void {
    if (typeof data !== "string") this.frames.push(decodeFrame(data));
  }
}

async function slowOrigin() {
  const pending: ServerResponse[] = [];
  const origin = createHttpServer(
    (_req: IncomingMessage, res: ServerResponse) => {
      pending.push(res);
    },
  );
  await new Promise<void>((resolve) =>
    origin.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = origin.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    pending,
    close: () => {
      origin.closeAllConnections();
      return new Promise<void>((resolve) => origin.close(() => resolve()));
    },
  };
}

function startSession(
  originUrl: string,
  sendsHeadPending: boolean,
  options: {
    hasBody?: boolean;
    now?: () => number;
    path?: string;
    target?: string;
  } = {},
) {
  const tunnel = new FakeTunnel();
  const session = new TunnelSession({
    tunnel: tunnel as unknown as NodeWebSocket,
    log: { warn: () => {} },
    sendsHeadPending,
    ...(options.now !== undefined ? { monotonicNow: options.now } : {}),
    resolveOrigin: () => ({
      kind: "ok",
      resolved: { origin: originUrl, publicOrigin: "https://bb.example" },
    }),
  });
  session.start();
  tunnel.emit(
    "message",
    Buffer.from(
      encodeFrame({
        type: "open-http",
        streamId: 7,
        method: "POST",
        path:
          options.path ?? "/api/v1/plugins/account-pool/http/v1/images/edits",
        headers: [],
        hasBody: options.hasBody ?? false,
        ...(options.target !== undefined ? { target: options.target } : {}),
      }),
    ),
    true,
  );
  const pendingFrames = () =>
    tunnel.frames.filter((frame) => frame.type === "head-pending");
  return { tunnel, session, pendingFrames };
}

describe("head-pending frames", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a slow origin until its response head arrives", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const origin = await slowOrigin();
    const { tunnel, session, pendingFrames } = startSession(origin.url, true);
    try {
      await vi.waitFor(() => expect(origin.pending).toHaveLength(1));
      vi.advanceTimersByTime(HEAD_PENDING_INTERVAL_MS * 3);
      expect(pendingFrames()).toEqual([
        { type: "head-pending", streamId: 7 },
        { type: "head-pending", streamId: 7 },
        { type: "head-pending", streamId: 7 },
      ]);

      origin.pending[0]?.end("{}");
      await vi.waitFor(() =>
        expect(tunnel.frames).toContainEqual({ type: "body-end", streamId: 7 }),
      );
      vi.advanceTimersByTime(HEAD_PENDING_INTERVAL_MS * 3);
      expect(pendingFrames()).toHaveLength(3);
    } finally {
      session.dispose();
      await origin.close();
    }
  });

  it("stops reporting when Connect closes the stream", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const origin = await slowOrigin();
    const { tunnel, session, pendingFrames } = startSession(origin.url, true);
    try {
      await vi.waitFor(() => expect(origin.pending).toHaveLength(1));
      vi.advanceTimersByTime(HEAD_PENDING_INTERVAL_MS);
      tunnel.emit(
        "message",
        Buffer.from(
          encodeFrame({
            type: "close-stream",
            streamId: 7,
            code: 1000,
            reason: "visitor left",
          }),
        ),
        true,
      );
      await vi.waitFor(() =>
        expect(session.snapshot(0).openHttpStreams).toBe(0),
      );
      vi.advanceTimersByTime(HEAD_PENDING_INTERVAL_MS * 3);
      expect(pendingFrames()).toHaveLength(1);
    } finally {
      session.dispose();
      await origin.close();
    }
  });

  it("reports at once when the request body took a full interval to arrive", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let now = 0;
    const origin = await slowOrigin();
    const { tunnel, session, pendingFrames } = startSession(origin.url, true, {
      hasBody: true,
      now: () => now,
    });
    try {
      now = 25_000;
      tunnel.emit(
        "message",
        Buffer.from(encodeFrame({ type: "body-end", streamId: 7 })),
        true,
      );
      expect(pendingFrames()).toEqual([{ type: "head-pending", streamId: 7 }]);
      await vi.waitFor(() => expect(origin.pending).toHaveLength(1));
    } finally {
      session.dispose();
      await origin.close();
    }
  });

  it("waits for the first interval when the request body arrived quickly", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let now = 0;
    const origin = await slowOrigin();
    const { tunnel, session, pendingFrames } = startSession(origin.url, true, {
      hasBody: true,
      now: () => now,
    });
    try {
      now = 2_000;
      tunnel.emit(
        "message",
        Buffer.from(encodeFrame({ type: "body-end", streamId: 7 })),
        true,
      );
      await vi.waitFor(() => expect(origin.pending).toHaveLength(1));
      expect(pendingFrames()).toEqual([]);
    } finally {
      session.dispose();
      await origin.close();
    }
  });

  it.each([
    { name: "a core API route", path: "/api/v1/threads/thr_1/timeline" },
    {
      name: "a port share",
      path: "/api/v1/plugins/account-pool/http/v1/images/edits",
      target: "3000",
    },
  ])(
    "keeps the base deadline for $name so a hung origin still fails fast",
    async ({ path, target }) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const origin = await slowOrigin();
      const { session, pendingFrames } = startSession(origin.url, true, {
        path,
        ...(target !== undefined ? { target } : {}),
      });
      try {
        await vi.waitFor(() => expect(origin.pending).toHaveLength(1));
        vi.advanceTimersByTime(HEAD_PENDING_INTERVAL_MS * 3);
        expect(pendingFrames()).toEqual([]);
      } finally {
        session.dispose();
        await origin.close();
      }
    },
  );

  it("sends nothing when Connect did not advertise support", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const origin = await slowOrigin();
    const { session, pendingFrames } = startSession(origin.url, false);
    try {
      await vi.waitFor(() => expect(origin.pending).toHaveLength(1));
      vi.advanceTimersByTime(HEAD_PENDING_INTERVAL_MS * 3);
      expect(pendingFrames()).toEqual([]);
    } finally {
      session.dispose();
      await origin.close();
    }
  });

  it("reads the advertisement from the tunnel upgrade response", () => {
    const upgrade = (headers: IncomingMessage["headers"]) =>
      ({ headers }) as IncomingMessage;
    expect(acceptsHeadPending(upgrade({ [HEAD_PENDING_HEADER]: "1" }))).toBe(
      true,
    );
    expect(acceptsHeadPending(upgrade({}))).toBe(false);
  });
});
