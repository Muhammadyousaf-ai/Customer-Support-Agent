import { Global, Module } from "@nestjs/common";
import { BudgetService } from "./budget.service.js";

@Global()
@Module({ providers: [BudgetService], exports: [BudgetService] })
export class BudgetModule {}
