import { z } from 'zod';

export type Endpoint<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> = {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly input: I;
  readonly output: O;
  readonly encoding: 'query' | 'json' | 'multipart';
  readonly authenticated: boolean;
  readonly raw: boolean;
  readonly timeout: number;
  readonly bodyLimit?: number;
};

type Settings = Partial<Pick<Endpoint, 'encoding' | 'authenticated' | 'raw' | 'timeout' | 'bodyLimit'>>;

export function get<I extends z.ZodType, O extends z.ZodType>(path: string, input: I, output: O, options: Settings = {}): Endpoint<I, O> {
  return { method: 'GET', path: `/api/${path}`, input, output, encoding: 'query', authenticated: true, raw: false, timeout: 30_000, ...options };
}

export function post<I extends z.ZodType, O extends z.ZodType>(path: string, input: I, output: O, options: Settings = {}): Endpoint<I, O> {
  return { method: 'POST', path: `/api/${path}`, input, output, encoding: 'json', authenticated: true, raw: false, timeout: 30_000, ...options };
}

export type Input<E extends Endpoint> = z.input<E['input']>;
export type Output<E extends Endpoint> = z.output<E['output']>;
