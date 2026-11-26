import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { PG_POOL } from "../database/tokens.js";

export interface ContractRecord {
  id: string;
  type: "monthly" | "annual" | "custom";
  status: "active" | "expired" | "suspended";
  startDate: string;
  endDate: string;
  autoRenew: boolean;
}

@Injectable()
export class ContractsService {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async getForCustomer(customerId: string): Promise<ContractRecord | null> {
    const { rows } = await this.pool.query(
      `select id, type, status, to_char(start_date,'YYYY-MM-DD') as start_date, to_char(end_date,'YYYY-MM-DD') as end_date, auto_renew
         from contracts where customer_id = $1 order by start_date desc limit 1`,
      [customerId],
    );
    const r = rows[0];
    return r ? { id: r.id, type: r.type, status: r.status, startDate: r.start_date, endDate: r.end_date, autoRenew: r.auto_renew } : null;
  }
}
