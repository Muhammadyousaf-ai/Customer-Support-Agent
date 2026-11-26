import { Inject, Injectable, Logger } from "@nestjs/common";
import type pg from "pg";
import { PG_POOL } from "../database/tokens.js";
import { moduleLogger } from "../observability/logging/logger.js";

const log = moduleLogger("mail");

/**
 * Mail goes to an outbox table. No provider (Resend/SMTP) is configured in this repository, so nothing is actually
 * delivered: in development read the link from the outbox (or the log); production needs a provider draining it.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async send(to: string, subject: string, body: string, purpose: string): Promise<void> {
    await this.pool.query("insert into email_outbox (to_address, subject, body, purpose) values ($1,$2,$3,$4)", [to, subject, body, purpose]);
    log.info({ event: "mail.queued", purpose }, "email queued (not delivered: no mail provider configured)");
    void this.logger;
  }
}
