/**
 * Document CRUD routes (§8.4): create / list / rename / soft-delete.
 * Mounted under /api/v1/docs.
 */
import { Router, type Request, type Response } from 'express'
import { docMetaRepo } from '../../db/repos/docMetaRepo.js'
import { buildDocumentName, DocumentNameError } from '../../permission/documentName.js'
import { newDocId } from '../../util/ids.js'
import { requireDocRole } from '../guard.js'

export const docsRouter = Router()

const DEFAULT_FOLDER = 'f_default'

/** POST /api/v1/docs — create. Creator becomes owner (implicit admin, §4.2). */
docsRouter.post('/', async (req: Request, res: Response) => {
  const uid = req.uid!
  const { spaceId, folderId, title, docType } = req.body ?? {}
  if (typeof spaceId !== 'string' || spaceId === '') {
    res.status(400).json({ error: 'spaceId required' })
    return
  }
  const folder = typeof folderId === 'string' && folderId !== '' ? folderId : DEFAULT_FOLDER
  const docId = newDocId()
  let documentName: string
  try {
    // documentName 3rd segment MUST equal folder_id (§8.1 invariant).
    documentName = buildDocumentName(spaceId, folder, docId)
  } catch (err) {
    if (err instanceof DocumentNameError) {
      res.status(400).json({ error: err.message })
      return
    }
    throw err
  }
  await docMetaRepo.create({
    docId,
    documentName,
    title: typeof title === 'string' ? title : '',
    ownerId: uid,
    spaceId,
    folderId: folder,
    docType: typeof docType === 'string' && docType !== '' ? docType : 'doc',
    createdBy: uid,
  })
  const meta = await docMetaRepo.getByDocId(docId)
  res.status(201).json({
    docId,
    documentName,
    title: meta?.title ?? '',
    spaceId,
    folderId: folder,
    ownerId: uid,
    role: 'admin',
    createdAt: meta?.created_at,
  })
})

/** GET /api/v1/docs — list docs the caller owns or is a member of. */
docsRouter.get('/', async (req: Request, res: Response) => {
  const uid = req.uid!
  const spaceId = typeof req.query.spaceId === 'string' ? req.query.spaceId : undefined
  const folderId = typeof req.query.folderId === 'string' ? req.query.folderId : undefined
  const page = Math.max(1, Number(req.query.page ?? 1) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20) || 20))
  const sort = req.query.sort === 'updatedAt:asc' ? 'updatedAt:asc' : 'updatedAt:desc'

  const { total, items } = await docMetaRepo.listForUser({ uid, spaceId, folderId, page, pageSize, sort })
  const roleName = (n: number) => (n === 3 ? 'admin' : n === 2 ? 'writer' : 'reader')
  res.status(200).json({
    total,
    items: items.map((d) => ({
      docId: d.doc_id,
      title: d.title,
      ownerId: d.owner_id,
      role: roleName(Number(d.role)),
      updatedAt: d.updated_at,
    })),
  })
})

/** PATCH /api/v1/docs/{docId} — rename (needs admin). */
docsRouter.patch('/:docId', async (req: Request, res: Response) => {
  const uid = req.uid!
  const docId = req.params.docId!
  const guard = await requireDocRole(res, uid, docId, 'admin')
  if (!guard) return
  const { title } = req.body ?? {}
  if (typeof title !== 'string' || title === '') {
    res.status(400).json({ error: 'title required' })
    return
  }
  await docMetaRepo.rename(docId, title)
  res.status(200).json({ docId, title })
})

/** DELETE /api/v1/docs/{docId} — soft delete (needs admin). */
docsRouter.delete('/:docId', async (req: Request, res: Response) => {
  const uid = req.uid!
  const docId = req.params.docId!
  const guard = await requireDocRole(res, uid, docId, 'admin')
  if (!guard) return
  await docMetaRepo.softDelete(docId)
  res.status(200).json({ docId, status: 'deleted' })
})
