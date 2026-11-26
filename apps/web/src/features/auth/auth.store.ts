"use client";

import type { AuthTokens, PublicUser } from "@support-ai/contracts";
import { create } from "zustand";
import { useConversationsStore } from "@/features/chat/store/conversations.store";
import { ApiError, request, type RequestOptions } from "@/features/chat/services/api.client";

/**
 * Access tokens live in memory only. The refresh token is kept in localStorage so a reload keeps the session; that is
 * readable by any script on this origin, so the app ships a strict CSP and renders no untrusted HTML (see docs/security.md).
 */
const RT_KEY = "support-ai:refresh";
const readRt = () => {
  try { return localStorage.getItem(RT_KEY); } catch { return null; }
};
const writeRt = (v: string | null) => {
  try { if (v) localStorage.setItem(RT_KEY, v); else localStorage.removeItem(RT_KEY); } catch { /* storage unavailable: session lasts until reload */ }
};

interface AuthState {
  status: "loading" | "anon" | "authed";
  user: PublicUser | null;
  accessToken: string | null;
  bootstrap: () => Promise<void>;
  login: (email: string, password: string) => Promise<PublicUser>;
  register: (email: string, password: string, displayName: string) => Promise<{ verificationRequired: boolean }>;
  logout: () => Promise<void>;
}

let refreshing: Promise<string | null> | null = null;
let booting: Promise<void> | null = null; // three shells call bootstrap on mount; share one attempt

export const useAuthStore = create<AuthState>((set, get) => {
  const accept = (t: AuthTokens) => {
    writeRt(t.refreshToken);
    set({ status: "authed", user: t.user, accessToken: t.accessToken });
  };
  const clear = () => {
    writeRt(null);
    set({ status: "anon", user: null, accessToken: null });
  };
  return {
    status: "loading",
    user: null,
    accessToken: null,
    bootstrap() {
      if (get().status !== "loading") return Promise.resolve();
      booting ??= (async () => {
        while (readRt()) {
          if (await refreshAccess()) return;
          if (!readRt()) break; // the API rejected the token (refreshAccess already cleared it)
          await new Promise((r) => setTimeout(r, 2000)); // API unreachable (e.g. restarting): keep the token and retry
        }
        set({ status: "anon" });
      })();
      return booting;
    },
    async login(email, password) {
      const t = await request<AuthTokens>("/auth/login", { method: "POST", body: { email, password } });
      accept(t);
      return t.user;
    },
    async register(email, password, displayName) {
      const r = await request<{ verificationRequired: boolean }>("/auth/register", { method: "POST", body: { email, password, displayName } });
      return { verificationRequired: r.verificationRequired };
    },
    async logout() {
      const { accessToken } = get();
      try {
        if (accessToken) await request("/auth/logout", { method: "POST", token: accessToken, body: { refreshToken: readRt() ?? undefined } });
      } catch { /* already signed out server-side */ }
      clear();
      useConversationsStore.setState({ items: [], activeId: null }); // the next person on this device must not see them
    },
  };
});

/** Single-flight refresh: concurrent 401s share one rotation, otherwise the second would replay a spent token and revoke the family. */
export function refreshAccess(): Promise<string | null> {
  refreshing ??= (async () => {
    const rt = readRt();
    if (!rt) return null;
    try {
      const t = await request<AuthTokens>("/auth/refresh", { method: "POST", body: { refreshToken: rt } });
      writeRt(t.refreshToken);
      useAuthStore.setState({ status: "authed", user: t.user, accessToken: t.accessToken });
      return t.accessToken;
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) return useAuthStore.getState().accessToken; // offline: keep what we have
      writeRt(null);
      useAuthStore.setState({ status: "anon", user: null, accessToken: null });
      return null;
    } finally {
      setTimeout(() => { refreshing = null; }, 0);
    }
  })();
  return refreshing;
}

/** Authenticated request with one transparent refresh on 401. */
export async function authed<T = unknown>(path: string, o: Omit<RequestOptions<undefined>, "token"> = {}): Promise<T> {
  let token = useAuthStore.getState().accessToken ?? (await refreshAccess());
  if (!token) throw new ApiError(401, "Please sign in.");
  try {
    return await request<T>(path, { ...o, token });
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e;
    token = await refreshAccess();
    if (!token) throw e;
    return request<T>(path, { ...o, token });
  }
}

export const homeFor = (role: PublicUser["role"]) => (role === "admin" ? "/admin" : role === "staff" ? "/staff" : "/customer/tickets");
