import { z } from "zod";

type RegisteredJob = {
  schema: z.ZodType<unknown>;
  handler: (payload: unknown) => Promise<void> | void;
};

const handlers = new Map<string, RegisteredJob>();

/**
 * Registers a durable-job handler.  Handlers must be idempotent: a worker can
 * crash after performing side effects and before the queue records completion.
 */
export function registerJob<TSchema extends z.ZodType>(
  type: string,
  schema: TSchema,
  handler: (payload: z.output<TSchema>) => Promise<void> | void,
): void {
  if (handlers.has(type)) {
    throw new Error(`A handler is already registered for job type ${type}`);
  }
  handlers.set(type, {
    schema,
    handler: handler as (payload: unknown) => Promise<void> | void,
  });
}

export function getRegisteredJob(type: string): RegisteredJob | undefined {
  return handlers.get(type);
}
