import { randomUUID } from "node:crypto"
import type {
  EventFilter,
  EventQuery,
  IRuntimeEventBus,
  RuntimeEvent,
  RuntimeEventHandler,
  RuntimeEventInput,
} from "./types.js"

const DEFAULT_EVENT_BUFFER_SIZE = 1_000

interface FilteredSubscription {
  filter: EventFilter
  handler: RuntimeEventHandler
}

export class RuntimeEventBus implements IRuntimeEventBus {
  private readonly handlers = new Set<RuntimeEventHandler>()
  private readonly filteredHandlers = new Set<FilteredSubscription>()
  private readonly buffer: RuntimeEvent[] = []

  constructor(private readonly maxEvents = DEFAULT_EVENT_BUFFER_SIZE) {
    if (!Number.isInteger(maxEvents) || maxEvents <= 0) {
      throw new Error("RuntimeEventBus maxEvents must be a positive integer")
    }
  }

  // ── overloaded subscribe ──────────────────────────────────────────────────

  subscribe(handler: RuntimeEventHandler): () => void
  subscribe(filter: EventFilter, handler: RuntimeEventHandler): () => void
  subscribe(filterOrHandler: RuntimeEventHandler | EventFilter, handler?: RuntimeEventHandler): () => void {
    // No-filter path: subscribe(handler)
    if (typeof filterOrHandler === "function") {
      this.handlers.add(filterOrHandler)
      return () => { this.handlers.delete(filterOrHandler) }
    }
    // Filtered path: subscribe(filter, handler)
    if (handler === undefined) {
      throw new Error("subscribe(filter, handler) requires a handler")
    }
    const sub: FilteredSubscription = { filter: filterOrHandler, handler }
    this.filteredHandlers.add(sub)
    return () => { this.filteredHandlers.delete(sub) }
  }

  // ── emit ──────────────────────────────────────────────────────────────────

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

    const ev: RuntimeEvent = {
      id: event.id,
      ts: event.ts,
      source: event.source,
      type: event.type,
      level: event.level,
      workspaceId: event.workspaceId,
      payload: event.payload as Record<string, unknown>,
    }
    if (event.taskId !== undefined) ev.taskId = event.taskId

    this.buffer.push(ev)
    while (this.buffer.length > this.maxEvents) this.buffer.shift()

    // Unfiltered handlers — receives everything
    for (const handler of this.handlers) handler(ev)

    // Filtered handlers — check filter match
    for (const sub of this.filteredHandlers) {
      if (this.matchesFilter(ev, sub.filter)) {
        sub.handler(ev)
      }
    }

    return event
  }

  // ── query ─────────────────────────────────────────────────────────────────

  getEvents(): RuntimeEvent[] {
    return [...this.buffer]
  }

  queryEvents(query: EventQuery): RuntimeEvent[] {
    const results: RuntimeEvent[] = []
    const since = query.since !== undefined ? new Date(query.since).getTime() : 0
    const limit = query.limit ?? Number.POSITIVE_INFINITY

    for (let i = this.buffer.length - 1; i >= 0 && results.length < limit; i--) {
      const ev = this.buffer[i]
      if (ev === undefined) continue
      if (since > 0 && new Date(ev.ts).getTime() <= since) continue
      if (!this.matchesFilter(ev, query)) continue
      results.unshift(ev) // restore chronological order
    }
    return results
  }

  clear(): void {
    this.buffer.length = 0
  }

  // ── private helpers ───────────────────────────────────────────────────────

  private matchesFilter(
    event: RuntimeEvent,
    filter: { types?: string[]; sources?: string[]; taskIds?: string[]; workspaceIds?: string[]; levels?: string[] },
  ): boolean {
    if (filter.types !== undefined && !filter.types.includes(event.type)) return false
    if (filter.sources !== undefined && !filter.sources.includes(event.source)) return false
    if (filter.workspaceIds !== undefined && !filter.workspaceIds.includes(event.workspaceId)) return false
    if (filter.levels !== undefined && !filter.levels.includes(event.level)) return false
    if (filter.taskIds !== undefined) {
      if (event.taskId === undefined) return false
      if (!filter.taskIds.includes(event.taskId)) return false
    }
    return true
  }
}

export function createRuntimeEventBus(maxEvents?: number): RuntimeEventBus {
  return new RuntimeEventBus(maxEvents)
}
