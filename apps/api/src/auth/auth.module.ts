import { Global, Module } from "@nestjs/common";
import { AuditService } from "../audit/audit.service.js";
import { PermissionsGuard } from "../authorization/guards/permissions.guard.js";
import { JwtAuthGuard } from "../authorization/guards/jwt-auth.guard.js";
import { UsersService } from "../users/users.service.js";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { MailService } from "./mail.service.js";
import { PasswordService } from "./password.service.js";
import { TokenService } from "./token.service.js";

/** Global: any module can use @Auth(...) and inject AuthService/UsersService without re-importing. */
@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, UsersService, PasswordService, TokenService, MailService, JwtAuthGuard, PermissionsGuard, AuditService],
  exports: [AuthService, UsersService, PasswordService, TokenService, MailService, JwtAuthGuard, PermissionsGuard],
})
export class AuthModule {}
