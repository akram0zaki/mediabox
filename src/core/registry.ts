import type { OperationHandler } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handlers = new Map<string, OperationHandler<any>>();

export function registerOperation<P>(handler: OperationHandler<P>): OperationHandler<P> {
  handlers.set(handler.type, handler);
  return handler;
}

export function getOperation<P = unknown>(type: string): OperationHandler<P> | undefined {
  return handlers.get(type) as OperationHandler<P> | undefined;
}

export function listOperations(): OperationHandler<unknown>[] {
  return [...handlers.values()];
}
