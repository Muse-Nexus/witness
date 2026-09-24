import type { Category, SourceType } from '../api/types';

export const CATEGORY_LABELS: Record<Category, string> = {
  love: 'Love',
  care: 'Care',
  pride: 'Pride',
  gratitude: 'Gratitude',
  trust: 'Trusted',
  belonging: 'Belonging',
  accomplishment: 'Accomplishment',
  recovery: 'Recovery',
  other: 'Other',
};

export const CATEGORIES = Object.keys(CATEGORY_LABELS) as Category[];

export const SOURCE_LABELS: Record<SourceType, string> = {
  email: 'Email',
  text: 'Texts',
  photo: 'Photos',
  screenshot: 'Screenshots',
  manual: 'Added by you',
  agent: 'Assistants',
  import: 'Imports',
};

/** Sources whose sender Witness can recognise again, so "never save from" makes sense. */
export function canBlockSender(source: SourceType): boolean {
  return source === 'email' || source === 'text';
}
