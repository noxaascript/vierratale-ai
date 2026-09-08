// Task-based model routing.
//
// Looks at the user's message and picks the most suitable VTL model:
//   - file/folder/code/diff/git work  -> qwen2.5-coder (VTL-3.3-Pro)
//   - research/knowledge questions    -> qwen3 reasoning (VTL-3.5-Reason)
//   - everything else (daily chat)    -> gemma (VTL-2.7-Flash, the default)
import { Catalog } from '../catalog.js';

const CODE_MODEL = 'VTL-3.3-Pro';
const RESEARCH_MODEL = 'VTL-3.5-Reason';

// Explicit file/folder/diff/git work routes to the coding model.
const CODE_PATTERNS = [
  /\b(file|files|folder|folders|directory|directories)\b/i,
  /\b(diff|diffs|changes|changed)\b/i,
  /\b(bug|bugs|bug fix|bugfix|fix|fixes|fixed|fixing)\b/i,
  /\b(refactor|refactoring|debug|debugging|syntax|compile|compile error|traceback|crash)\b/i,
  /\b(git|commit|commits|committing|merge|merging|pull request|merge request|repository)\b/i,
  /\b(\.py|\.js|\.jsx|\.ts|\.tsx|\.html?|\.css|\.json|\.env|\.gitignore)\b/i,
  /\b(package\.json|requirements\.txt|dockerfile|docker-compose(?:\.yml|\.yaml)?|setup\.py)\b/i,
  /\b(script|app\.py|main\.py|server\.py|manage\.py|index\.html)\b/i,
  /\b(create|write|make|update|edit|modify|add|remove|delete)\b[^.!?\n]{0,60}\b(file|folder|directory|code|script|function|class|website|web app|app|project|config)\b/i,
];

// Research / knowledge requests route to the reasoning model.
const RESEARCH_PATTERNS = [
  /\b(research|researching|study|studies|analyze|analyse|explain|explanation|elaborate)\b/i,
  /\bdifference between\b/i,
  /\b(compare|comparison)\b/i,
  /\b(summary|summarize|summarise|overview)\b/i,
  /\b(meaning|definition|history|background|purpose|concept|theory|principle|mechanism)\b/i,
  /\b(learn|teach me|tutorial|guide)\b/i,
  /\b(what is|what are|what's|why is|why does|why do|how does|how to|how do)\b/i,
  /\b(latest|news|current events|state of the art)\b/i,
];

export function routeModel(text) {
  const s = String(text || '').trim().toLowerCase();
  if (!s || s.startsWith('/')) return null;

  if (CODE_PATTERNS.some((re) => re.test(s))) return CODE_MODEL;
  if (RESEARCH_PATTERNS.some((re) => re.test(s))) return RESEARCH_MODEL;
  return Catalog.getDefaultModel();
}