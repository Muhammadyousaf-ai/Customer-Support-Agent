import { Injectable } from "@nestjs/common";
import { hash, verify } from "@node-rs/argon2";

/** @node-rs/argon2 Algorithm.Argon2id (a const enum cannot be imported under isolatedModules). */
const ARGON2ID = 2;

/** Argon2id (the OWASP-recommended memory-hard KDF) with the library's safe defaults. */
@Injectable()
export class PasswordService {
  hash(password: string): Promise<string> {
    return hash(password, { algorithm: ARGON2ID });
  }

  async verify(passwordHash: string | null, password: string): Promise<boolean> {
    if (!passwordHash) return false;
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  /** Burns comparable time when the account does not exist, so response timing does not reveal which emails are registered. */
  private dummy: Promise<string> | null = null;
  async verifyDummy(password: string): Promise<void> {
    this.dummy ??= this.hash("not-a-real-password-1234");
    await this.verify(await this.dummy, password);
  }
}
