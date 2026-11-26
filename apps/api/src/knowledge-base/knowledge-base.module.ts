import { Module } from "@nestjs/common";
import { AuditService } from "../audit/audit.service.js";
import { RagModule } from "../rag/rag.module.js";
import { KnowledgeBaseController } from "./knowledge-base.controller.js";
import { KnowledgeBaseService } from "./knowledge-base.service.js";

@Module({ imports: [RagModule], controllers: [KnowledgeBaseController], providers: [KnowledgeBaseService, AuditService] })
export class KnowledgeBaseModule {}
