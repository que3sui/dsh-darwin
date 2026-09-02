/**
 * 与官方 dsh-storage KvTable 对齐的最小结构切面（structural typing）。
 * 运行时传入真实的 domain.table(name) 即可；测试用 MemoryKvStore。
 * 我们只声明自己用到的四个方法——上游加字段/改签名时受影响面最小。
 */

export interface KvTableLike<V> {
  get(key: string): V | undefined
  entries(): Array<[string, V]>
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<void>
}

export class MemoryKvStore<V> implements KvTableLike<V> {
  private map = new Map<string, V>()

  get(key: string): V | undefined {
    return this.map.get(key)
  }

  entries(): Array<[string, V]> {
    return [...this.map.entries()]
  }

  async put(key: string, value: V): Promise<void> {
    this.map.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }
}

/** 表名 → 存储 的极简域抽象；wire 层负责把真实 Domain 适配成它 */
export interface DomainLike {
  table(name: string): KvTableLike<unknown>
}

/** 带 id 记录的通用集合访问（all/get/save），底层是任意 KvTableLike */
export class KvCollection<T extends { id: string }> {
  private table: KvTableLike<T>

  constructor(table: KvTableLike<T>) {
    this.table = table
  }

  async all(): Promise<T[]> {
    return [...this.table.entries()].map(([, v]) => v)
  }

  async get(id: string): Promise<T | undefined> {
    return this.table.get(id)
  }

  async save(item: T): Promise<void> {
    await this.table.put(item.id, item)
  }

  async remove(id: string): Promise<void> {
    await this.table.delete(id)
  }
}
