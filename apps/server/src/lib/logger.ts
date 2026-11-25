import type { FastifyServerOptions } from 'fastify';
import { config } from '../config.ts';

const SECRET_QUERY = /([?&](?:code|state|code_verifier|access_token|refresh_token|apikey|api_key)=)[^&#]*/gi;

/** Strips sensitive values from query strings before logging. */
export function scrubUrl(url: string): string {
  return url.replace(SECRET_QUERY, '$1[redacted]');
}

export const loggerOptions: FastifyServerOptions['logger'] = {
  level: config.logLevel,
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'res.headers["set-cookie"]',
      'headers.authorization',
      'headers.cookie',
      '*.access_token',
      '*.refresh_token',
      '*.code_verifier',
      '*.apiKey',
      '*.apikey',
      '*.token',
    ],
    censor: '[redacted]',
  },
  serializers: {
    req(req) {
      return { method: req.method, url: scrubUrl(req.url), ip: req.ip };
    },
    res(res) {
      return { statusCode: res.statusCode };
    },
  },
  ...(config.isProd ? {} : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
};
