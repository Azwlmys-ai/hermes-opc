import { randomUUID } from "node:crypto"
import type {
  IRuntimeEventBus,
  RuntimeEvent,
  RuntimeEventHandler,
  RuntimeEventInput,
} from "./types.js"

const DEFAULT_EVENT_BUFFER_SIZE = 1_000

export class RuntimeEventBus implements IRuntimeEventBus {
  private readonly handlers = new Set<RuntimeEventHandler>()
  private readonly buffer: RuntimeEvent[] = []

  constructor(private readonly maxEvents = DEFAULT_EVENT_BUFFER_SIZE) {
    if (!Number.isInteger(maxEvents) || maxEvents <= 0) {
      throw new Error("RuntimeEventBus maxEvents must be a positive integer")
    }
  }

  emit<TPayload = Record<string, unknown>>(input: RuntimeEventInput<TPayload>): RuntimeEvent<TPayload> {
    const event: RuntimeEvent<TPayload> = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      source: input.source,
      type: input.type,
      level: input.level ?? "info",
      workspaceId: input.workspaceId,
      payload: input.payload ?? ({} as TPayload),
    }
    if (input.taskId !== undefined) event.taskId = input.taskId

    this.buffer.push(event as RuntimeEvent)
    while (this.buffer.length > this.maxEvents) this.buffer.shift()

    for (const handler of this.handlers) handler(event as RuntimeEvent)
    return event
  }

  subscribe(handler: RuntimeEventHandler): () => void {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }

  getEvents(): RuntimeEvent[] {
    return [...this.buffer]
  }

  clear(): void {
    this.buffer.length = 0
  }
}

export function createRuntimeEventBus(maxEvents?: number): RuntimeEventBus {
  return new RuntimeEventBus(maxEvents)
}