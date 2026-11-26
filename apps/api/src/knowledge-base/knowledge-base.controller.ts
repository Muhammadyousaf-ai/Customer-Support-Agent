import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseIntPipe, Post, Put, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { kbSourceSchema, kbTestSchema } from "@support-ai/contracts";
import { z } from "zod";
import type { AuthUser } from "../auth/auth.types.js";
import { Auth, CurrentUser } from "../authorization/decorators/auth.decorator.js";
import { KnowledgeBaseService } from "./knowledge-base.service.js";

const parse = <T extends z.ZodType>(schema: T, body: unknown): z.output<T> => {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new BadRequestException(z.prettifyError(r.error));
  return r.data;
};
const uploadMeta = z.object({ title: z.string().max(200).optional(), category: z.string().max(40).optional() });
const restoreBody = z.object({ publish: z.boolean().optional() });
const publishBody = z.object({ version: z.number().int().min(1).optional() });
const MAX_UPLOAD = Number(process.env.KB_MAX_UPLOAD_BYTES ?? 5_000_000);

@Controller("admin/kb")
@Auth("kb.manage")
export class KnowledgeBaseController {
  constructor(@Inject(KnowledgeBaseService) private readonly kb: KnowledgeBaseService) {}

  @Get("documents")
  list() {
    return this.kb.list();
  }

  @Post("documents")
  @HttpCode(201)
  create(@Body() body: unknown, @CurrentUser() admin: AuthUser) {
    return this.kb.create(admin, parse(kbSourceSchema, body).source);
  }

  /** Multipart upload (md, txt, pdf). Creates a draft; nothing is indexed until it is published. */
  @Post("upload")
  @HttpCode(201)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_UPLOAD, files: 1 } }))
  async upload(@UploadedFile() file: { originalname: string; buffer: Buffer; mimetype: string } | undefined, @Body() body: unknown, @CurrentUser() admin: AuthUser) {
    if (!file) throw new BadRequestException("Attach a file in the `file` field.");
    const meta = parse(uploadMeta, body);
    return this.kb.create(admin, await this.kb.sourceFromUpload(file, meta));
  }

  @Post("preview")
  @HttpCode(200)
  preview(@Body() body: unknown) {
    return this.kb.preview(parse(kbSourceSchema, body).source);
  }

  @Post("test")
  @HttpCode(200)
  test(@Body() body: unknown) {
    return this.kb.test(parse(kbTestSchema, body));
  }

  @Get("documents/:id")
  get(@Param("id") id: string) {
    return this.kb.get(id);
  }

  @Get("documents/:id/versions/:version")
  async version(@Param("id") id: string, @Param("version", ParseIntPipe) version: number) {
    return { version, source: await this.kb.versionSource(id, version) };
  }

  @Put("documents/:id")
  save(@Param("id") id: string, @Body() body: unknown, @CurrentUser() admin: AuthUser) {
    return this.kb.saveDraft(admin, id, parse(kbSourceSchema, body).source);
  }

  @Post("documents/:id/publish")
  @HttpCode(200)
  publish(@Param("id") id: string, @Body() body: unknown, @CurrentUser() admin: AuthUser) {
    return this.kb.publish(admin, id, parse(publishBody, body).version);
  }

  @Post("documents/:id/reindex")
  @HttpCode(200)
  reindex(@Param("id") id: string, @CurrentUser() admin: AuthUser) {
    return this.kb.reindex(admin, id);
  }

  @Post("documents/:id/versions/:version/restore")
  @HttpCode(200)
  restore(@Param("id") id: string, @Param("version", ParseIntPipe) version: number, @Body() body: unknown, @CurrentUser() admin: AuthUser) {
    return this.kb.restore(admin, id, version, parse(restoreBody, body).publish);
  }

  @Delete("documents/:id")
  @HttpCode(204)
  async remove(@Param("id") id: string, @CurrentUser() admin: AuthUser) {
    await this.kb.remove(admin, id);
  }
}
