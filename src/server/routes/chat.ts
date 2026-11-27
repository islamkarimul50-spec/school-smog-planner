import { Router } from 'express';
import { ChatRequestSchema } from '../../shared/validation.js';
import type { GeminiCoachService } from '../services/geminiService.js';

export function createChatRouter(geminiService: GeminiCoachService): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          parsed.error.issues[0]?.message ??
          'Invalid follow-up question payload.',
        fieldErrors: parsed.error.flatten().fieldErrors
      });
      return;
    }

    const payload = await geminiService.answerFollowUp(parsed.data);
    res.json(payload);
  });

  return router;
}
