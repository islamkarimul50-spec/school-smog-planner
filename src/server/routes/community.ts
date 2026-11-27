import { Router } from 'express';
import { CommunityNoticeInputSchema } from '../../shared/validation.js';
import type { CommunityStore } from '../services/communityStore.js';

export function createCommunityRouter(communityStore: CommunityStore): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ notices: communityStore.listNotices() });
  });

  router.post('/', (req, res) => {
    const parsed = CommunityNoticeInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          parsed.error.issues[0]?.message ??
          'Community message failed validation or privacy checks.',
        fieldErrors: parsed.error.flatten().fieldErrors
      });
      return;
    }

    const notice = communityStore.addNotice(parsed.data);
    res.status(201).json({
      notice,
      notices: communityStore.listNotices()
    });
  });

  return router;
}
