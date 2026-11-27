import { SEEDED_COMMUNITY_NOTICES } from '../../shared/constants.js';
import type { CommunityCategory, CommunityNotice } from '../../shared/types.js';

const MAX_STORED_NOTICES = 40;

export class CommunityStore {
  private notices: CommunityNotice[];

  constructor() {
    this.notices = [...SEEDED_COMMUNITY_NOTICES];
  }

  public listNotices(): CommunityNotice[] {
    return [...this.notices];
  }

  public addNotice(input: {
    category: CommunityCategory;
    corridorZone: string;
    schoolWindow: string;
    message: string;
  }): CommunityNotice {
    const notice: CommunityNotice = {
      id: `notice-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      category: input.category,
      corridorZone: input.corridorZone.trim(),
      schoolWindow: input.schoolWindow.trim(),
      message: input.message.trim(),
      createdAtIso: new Date().toISOString(),
      isSample: false
    };

    this.notices = [notice, ...this.notices].slice(0, MAX_STORED_NOTICES);
    return notice;
  }

  public resetToSeed(): void {
    this.notices = [...SEEDED_COMMUNITY_NOTICES];
  }
}
