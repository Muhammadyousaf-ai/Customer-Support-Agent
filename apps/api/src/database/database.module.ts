import { Global, Module } from "@nestjs/common";
import { PG_POOL } from "./tokens.js";
import { pool } from "./pool.js";

@Global()
@Module({ providers: [{ provide: PG_POOL, useValue: pool }], exports: [PG_POOL] })
export class DatabaseModule {}
