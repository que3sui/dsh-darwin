import { DARWIN_TABLES, type KvTableLike, type ProblemTicket } from '@dsh-darwin/protocol'

export interface TicketStore {
  all(): Promise<ProblemTicket[]>
  saveMany(tickets: ProblemTicket[]): Promise<void>
}

export class MemoryTicketStore implements TicketStore {
  private kv = new Map<string, ProblemTicket>()

  async all(): Promise<ProblemTicket[]> {
    return [...this.kv.values()]
  }

  async saveMany(tickets: ProblemTicket[]): Promise<void> {
    for (const t of tickets) this.kv.set(t.id, t)
  }
}

/** 用官方 storageDomain 的 KvTable（结构切面）做持久化 */
export class DomainTicketStore implements TicketStore {
  constructor(private table: KvTableLike<ProblemTicket>) {}

  static tableOf(domain: { table(name: string): KvTableLike<unknown> }): KvTableLike<ProblemTicket> {
    return domain.table(DARWIN_TABLES.tickets) as KvTableLike<ProblemTicket>
  }

  async all(): Promise<ProblemTicket[]> {
    return [...this.table.entries()].map(([, v]) => v)
  }

  async saveMany(tickets: ProblemTicket[]): Promise<void> {
    for (const t of tickets) await this.table.put(t.id, t)
  }
}
