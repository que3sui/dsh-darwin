import { describe, expect, it } from 'vitest'
import { wireTicketStore, openOrAttach } from '../src/dsh-adapter.ts'
import { MemoryKvStore, ProblemTicket, type KvTableLike } from '../src/protocol.ts'
import { DomainTicketStore } from '../src/store.ts'

type Handle = { table(name: string): KvTableLike<unknown> }

function ticket(id: string): ProblemTicket {
  return ProblemTicket.parse({
    protocolVersion: '0.1.0',
    id,
    kind: 'retry-loop',
    title: `t-${id}`,
    severity: 10,
    fingerprint: `aa11bb22cc33dd${id.padStart(2, '0')}`,
    occurrences: 1,
    createdAt: 1,
    updatedAt: 1,
    lastSeenAt: 1,
  })
}

describe('域打开竞态（VERIFIED 实机坑）', () => {
  it('撞 already-open 时轮询 get() 恢复共享句柄，不降级内存', async () => {
    const handle: Handle = { table: () => new MemoryKvStore() }
    let opened = false
    const svc = {
      get: () => (opened ? handle : undefined),
      open: async () => {
        // 模拟先行者已 reserve 域名但尚未注册（get 仍为 undefined）
        throw new Error(`domain 'darwin' is already open`)
      },
    }
    // 先行者 50ms 后完成注册
    setTimeout(() => {
      opened = true
    }, 50)

    const got = await openOrAttach(svc as never)
    expect(got).toBe(handle)
  })

  it('wireTicketStore 在竞态场景产出 DomainTicketStore（可共享）', async () => {
    const handle: Handle = { table: () => new MemoryKvStore() }
    let opened = false
    const svc = {
      get: () => (opened ? handle : undefined),
      open: async () => {
        throw new Error(`domain 'darwin' is already open`)
      },
    }
    setTimeout(() => {
      opened = true
    }, 30)

    const store = await wireTicketStore(svc as never)
    expect(store).toBeInstanceOf(DomainTicketStore)
    await store.saveMany([ticket('race-1')])
    expect((await store.all()).map((t) => t.id)).toEqual(['race-1'])
  })

  it('真正失败（非 already-open）仍回退内存并告警', async () => {
    const warns: string[] = []
    const svc = {
      get: () => undefined,
      open: async () => {
        throw new Error('backend not found')
      },
    }
    const store = await wireTicketStore(svc as never, { warn: (m) => warns.push(String(m)) })
    expect(store).not.toBeInstanceOf(DomainTicketStore)
    expect(warns[0]).toContain('backend not found')
  })
})
