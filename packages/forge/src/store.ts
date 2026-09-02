import {
  DARWIN_TABLES,
  KvCollection,
  type CandidatePlugin,
  type KvTableLike,
  type SkillSnapshot,
} from './protocol.ts'

export interface CandidateStore {
  all(): Promise<CandidatePlugin[]>
  get(id: string): Promise<CandidatePlugin | undefined>
  save(candidate: CandidatePlugin): Promise<void>
}

export class MemoryCandidateStore implements CandidateStore {
  private kv = new Map<string, CandidatePlugin>()
  async all(): Promise<CandidatePlugin[]> {
    return [...this.kv.values()]
  }
  async get(id: string): Promise<CandidatePlugin | undefined> {
    return this.kv.get(id)
  }
  async save(candidate: CandidatePlugin): Promise<void> {
    this.kv.set(candidate.id, candidate)
  }
}

export class DomainCandidateStore implements CandidateStore {
  private col: KvCollection<CandidatePlugin>
  constructor(table: KvTableLike<CandidatePlugin>) {
    this.col = new KvCollection(table)
  }
  async all(): Promise<CandidatePlugin[]> {
    return this.col.all()
  }
  async get(id: string): Promise<CandidatePlugin | undefined> {
    return this.col.get(id)
  }
  async save(candidate: CandidatePlugin): Promise<void> {
    await this.col.save(candidate)
  }
}

export interface SnapshotStore {
  latest(skillName: string): Promise<SkillSnapshot | undefined>
  save(snapshot: SkillSnapshot): Promise<void>
}

export class MemorySnapshotStore implements SnapshotStore {
  private kv = new Map<string, SkillSnapshot>()
  async latest(skillName: string): Promise<SkillSnapshot | undefined> {
    return this.kv.get(skillName)
  }
  async save(snapshot: SkillSnapshot): Promise<void> {
    this.kv.set(snapshot.skillName, snapshot)
  }
}

/** MVP 只保留最新快照（按 skillName 覆盖）；版本链在 P3 引入 lineage 表后开放 */
export class DomainSnapshotStore implements SnapshotStore {
  private table: KvTableLike<SkillSnapshot>

  constructor(table: KvTableLike<SkillSnapshot>) {
    this.table = table
  }
  async latest(skillName: string): Promise<SkillSnapshot | undefined> {
    return this.table.get(skillName)
  }
  async save(snapshot: SkillSnapshot): Promise<void> {
    await this.table.put(snapshot.skillName, snapshot)
  }
}

export function candidateTableOf(domain: { table(name: string): KvTableLike<unknown> }): KvTableLike<CandidatePlugin> {
  return domain.table(DARWIN_TABLES.candidates) as KvTableLike<CandidatePlugin>
}

export function snapshotTableOf(domain: { table(name: string): KvTableLike<unknown> }): KvTableLike<SkillSnapshot> {
  return domain.table(DARWIN_TABLES.snapshots) as KvTableLike<SkillSnapshot>
}
