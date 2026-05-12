/**
 * Structured Logger for Access Logs
 * Format: [TIMESTAMP] [LEVEL] [METHOD/ROUTE] [USER_ID] [ROLE] MESSAGE
 */

export enum LogLevel {
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  ACCESS = 'ACCESS',
}

interface LogContext {
  userId?: string;
  role?: string;
  shopId?: string;
  method?: string;
  route?: string;
  ip?: string;
  userAgent?: string;
}

export class Logger {
  private static formatTimestamp(): string {
    return new Date().toISOString();
  }

  private static formatMessage(level: LogLevel, message: string, context?: LogContext): string {
    const timestamp = this.formatTimestamp();
    const userPart = context?.userId ? `[${context.userId}]` : '';
    const rolePart = context?.role ? `[${context.role}]` : '';
    const shopPart = context?.shopId ? `[${context.shopId}]` : '';
    const methodPart = context?.method ? `[${context.method}]` : '';
    const routePart = context?.route ? `[${context.route}]` : '';

    return `[${timestamp}] [${level}] ${methodPart}${routePart}${userPart}${rolePart}${shopPart} ${message}`;
  }

  static access(message: string, context?: LogContext): void {
    console.log(this.formatMessage(LogLevel.ACCESS, message, context));
  }

  static info(message: string, context?: LogContext): void {
    console.log(this.formatMessage(LogLevel.INFO, message, context));
  }

  static warn(message: string, context?: LogContext): void {
    console.warn(this.formatMessage(LogLevel.WARN, message, context));
  }

  static error(message: string, context?: LogContext): void {
    console.error(this.formatMessage(LogLevel.ERROR, message, context));
  }
}
