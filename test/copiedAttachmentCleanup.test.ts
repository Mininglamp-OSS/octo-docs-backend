import { beforeEach, describe, expect, it, vi } from 'vitest'

const { deleteObject } = vi.hoisted(() => ({ deleteObject: vi.fn() }))
vi.mock('../src/storage/objectStore.js', () => ({
  getObjectStore: () => ({ delete: deleteObject }),
}))
vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/db/pool.js', () => ({ query: vi.fn(), transaction: vi.fn() }))

import { cleanupCopiedAttachment } from '../src/api/routes/attachments.js'
import { docAttachmentRepo } from '../src/db/repos/docAttachmentRepo.js'

describe('copied attachment cleanup', () => {
  beforeEach(() => vi.clearAllMocks())

  it('retains the DB retry cursor when object deletion fails', async () => {
    vi.spyOn(docAttachmentRepo, 'getById').mockResolvedValue({ attachId: 'att_1', objectKey: 'd/att_1/a', docId: 'd' } as never)
    const deleteRow = vi.spyOn(docAttachmentRepo, 'deleteById').mockResolvedValue()
    deleteObject.mockRejectedValueOnce(new Error('transient'))

    await expect(cleanupCopiedAttachment('att_1')).rejects.toThrow('transient')
    expect(deleteRow).not.toHaveBeenCalled()

    deleteObject.mockResolvedValueOnce(undefined)
    await cleanupCopiedAttachment('att_1')
    expect(deleteRow).toHaveBeenCalledWith('att_1')
  })
})
