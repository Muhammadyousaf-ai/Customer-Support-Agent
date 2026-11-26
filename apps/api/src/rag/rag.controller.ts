import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Post, UseGuards } from "@nestjs/common";
import { ragSearchRequestSchema } from "@support-ai/contracts";
import { z } from "zod";
import { AdminGuard } from "./admin.guard.js";
import { IngestionService } from "./ingestion/ingestion.service.js";
import { RagService } from "./rag.service.js";

@Controller("rag")
export class RagController {
  constructor(
    @Inject(RagService) private readonly rag: RagService,
    @Inject(IngestionService) private readonly ingestion: IngestionService,
  ) {}

  @Post("ingest")
  @HttpCode(200)
  @UseGuards(AdminGuard)
  ingest() {
    return this.ingestion.ingestDirectory();
  }

  /**
   * Test endpoint. In production the agent calls RagService directly with the tier and contract type taken from
   * trusted backend records; client-supplied values must never drive that decision.
   */
  @Post("search")
  @HttpCode(200)
  search(@Body() body: unknown) {
    const parsed = ragSearchRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(z.prettifyError(parsed.error));
    return this.rag.search(parsed.data);
  }

  @Get("documents")
  @UseGuards(AdminGuard)
  documents() {
    return this.rag.listDocuments();
  }

  @Get("health")
  health() {
    return this.rag.health();
  }
}
