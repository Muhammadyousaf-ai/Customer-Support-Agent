import { afterEach, expect, test, vi } from "vitest";
import { useAuthStore } from "./auth.store";

afterEach(() => {
  if (vi.isFakeTimers()) vi.runOnlyPendingTimers(); // lets the single-flight refresh reset between tests
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

test("a reload while the API is restarting keeps the session instead of signing out", async () => {
  vi.useFakeTimers();
  localStorage.setItem("support-ai:refresh", "rt-1");
  const user = { id: "u1", email: "a@example.com", displayName: "A", role: "customer" };
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("Failed to fetch")) // API down
    .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: "at", refreshToken: "rt-2", user }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);

  const done = useAuthStore.getState().bootstrap();
  await vi.advanceTimersByTimeAsync(0);
  expect(useAuthStore.getState().status).toBe("loading");
  expect(localStorage.getItem("support-ai:refresh")).toBe("rt-1");

  await vi.advanceTimersByTimeAsync(2000);
  await done;
  expect(useAuthStore.getState().status).toBe("authed");
  expect(localStorage.getItem("support-ai:refresh")).toBe("rt-2");
});

test("starting a conversation after the access token expired refreshes it instead of failing", async () => {
  const { createSession } = await import("@/features/chat/services/session.service");
  const user = { id: "u1", email: "a@example.com", displayName: "A", role: "customer" };
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  localStorage.setItem("support-ai:refresh", "rt-1");
  useAuthStore.setState({ status: "authed", user: user as never, accessToken: "expired" });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(json({ message: "Sign in to start a conversation." }, 401))
    .mockResolvedValueOnce(json({ accessToken: "fresh", refreshToken: "rt-2", user }))
    .mockResolvedValueOnce(json({ sessionId: "ses_1", sessionToken: "st", expiresAt: "2030-01-01T00:00:00Z" }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(createSession()).resolves.toMatchObject({ sessionId: "ses_1" });
  expect(fetchMock.mock.calls[2]![1].headers.authorization).toBe("Bearer fresh");
  expect(localStorage.getItem("support-ai:refresh")).toBe("rt-2");
});
