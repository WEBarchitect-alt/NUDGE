import Dexie, { type EntityTable } from 'dexie';

export interface Commitment {
  id?: number;
  title: string;
  syllabusOrTopics: string;
  targetTime: Date;
  status: 'pending' | 'completed' | 'failed';
  score?: number;
  xpEarned?: number;
  mentorFeedback?: string;
  createdAt: Date;
}

export interface UserSettings {
  id?: number;
  geminiApiKey: string;
  userName: string;
  currentStreak: number;
  totalXp: number;
}

const db = new Dexie('NudgeDatabase') as Dexie & {
  commitments: EntityTable<Commitment, 'id'>;
  settings: EntityTable<UserSettings, 'id'>;
};

db.version(1).stores({
  commitments: '++id, targetTime, status, createdAt',
  settings: '++id'
});

export { db };