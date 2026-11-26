"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, request } from "@/features/chat/services/api.client";
import { homeFor, useAuthStore } from "../auth.store";
import { AuthCard } from "./auth-card";
import { Field } from "./field";

const message = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Please try again.");
const ErrorText = ({ text }: { text: string | null }) => (text ? <p role="alert" className="text-sm text-destructive">{text}</p> : null);

/** Only same-origin relative paths are honoured, so `?next=` cannot be used as an open redirect. */
const safeNext = (n: string | null) => (n && n.startsWith("/") && !n.startsWith("//") ? n : null);

function useSubmit(fn: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) { setError(message(err)); } finally { setBusy(false); }
  };
  return { busy, error, submit };
}

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const login = useAuthStore((s) => s.login);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, submit } = useSubmit(async () => {
    const user = await login(email, password);
    const next = safeNext(params.get("next"));
    // The chat is customer-only: staff and admins land on their dashboard even if they arrived via /support.
    router.replace(next && !(user.role !== "customer" && next.startsWith("/support")) ? next : homeFor(user.role));
  });
  return (
    <AuthCard title="Sign in" subtitle="Customers, support staff and administrators sign in here." footer={<><Link className="text-primary" href="/register">Create a customer account</Link></>}>
      <form onSubmit={submit} className="space-y-4">
        <Field id="email" label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field id="password" label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <ErrorText text={error} />
        <Button type="submit" className="w-full" loading={busy}>Sign in</Button>
      </form>
    </AuthCard>
  );
}
export const LoginForm = () => <Suspense><LoginInner /></Suspense>;

export function RegisterForm() {
  const register = useAuthStore((s) => s.register);
  const login = useAuthStore((s) => s.login);
  const router = useRouter();
  const [f, setF] = useState({ displayName: "", email: "", password: "" });
  const [pending, setPending] = useState(false);
  const { busy, error, submit } = useSubmit(async () => {
    const r = await register(f.email, f.password, f.displayName);
    if (r.verificationRequired) return setPending(true);
    await login(f.email, f.password);
    router.replace("/customer/tickets");
  });
  if (pending) return <AuthCard title="Check your email" subtitle={`We sent a confirmation link to ${f.email}. Open it to activate your account.`} footer={<Link className="text-primary" href="/login">Back to sign in</Link>}><span /></AuthCard>;
  return (
    <AuthCard title="Create your account" subtitle="Customer accounts keep your conversations and support tickets together." footer={<>Already registered? <Link className="text-primary" href="/login">Sign in</Link></>}>
      <form onSubmit={submit} className="space-y-4">
        <Field id="name" label="Name" required maxLength={80} value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} />
        <Field id="email" label="Email" type="email" autoComplete="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <Field id="password" label="Password" type="password" autoComplete="new-password" required minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        <p className="text-xs text-muted-foreground">At least 10 characters, with letters and a digit.</p>
        <ErrorText text={error} />
        <Button type="submit" className="w-full" loading={busy}>Create account</Button>
      </form>
    </AuthCard>
  );
}

function ResetInner() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const { busy, error, submit } = useSubmit(async () => {
    await request("/auth/accept-invite", { method: "POST", body: { token, password } });
    router.replace("/login");
  });
  return (
    <AuthCard title="Welcome to the team" subtitle="Set a password to activate your staff account.">
      {token ? (
        <form onSubmit={submit} className="space-y-4">
          <Field id="password" label="New password" type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
          <ErrorText text={error} />
          <Button type="submit" className="w-full" loading={busy}>Activate account</Button>
        </form>
      ) : <p className="text-sm text-destructive">This link is missing its token. Open the link from your email again.</p>}
    </AuthCard>
  );
}
export const ResetPasswordForm = () => <Suspense><ResetInner /></Suspense>;

function VerifyInner() {
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = useState<"working" | "ok" | "failed">(token ? "working" : "failed");
  useEffect(() => {
    if (!token) return;
    request("/auth/verify-email", { method: "POST", body: { token } }).then(() => setState("ok"), () => setState("failed"));
  }, [token]);
  return (
    <AuthCard title="Email confirmation" subtitle={state === "working" ? "Confirming…" : state === "ok" ? "Your email is confirmed. You can sign in now." : "This link is invalid or has expired."} footer={<Link className="text-primary" href="/login">Go to sign in</Link>}><span /></AuthCard>
  );
}
export const VerifyEmail = () => <Suspense><VerifyInner /></Suspense>;
