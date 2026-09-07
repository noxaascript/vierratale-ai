const QUESTION_PREFIXES = [
  'who', 'what', 'when', 'where', 'why', 'how',
  'which', 'whose', 'whom', 'is', 'are', 'was', 'were',
  'can', 'could', 'does', 'do', 'did', 'would', 'should', 'will',
];

const KNOWLEDGE_PREFIXES = [
  'tell me about', "what is", "what's", "who is", "who's",
  'what are', 'who was', 'when did', 'when was', 'where is',
  'where was', 'how did', 'how does', 'how to', 'why did', 'why is',
  'latest', 'news', 'current',
];

const SELF_PHRASES = [
  'what model', 'which model', 'what model are you', 'which model are you',
  'what are you', 'who are you', "what's your name", 'what is your name',
  'what language model', 'what llm', 'what ai model', 'what ai are you',
  'your model', 'what model do you use', 'what model you use',
  'what engine', 'which engine', 'are you gpt', 'are you chatgpt',
];

const ACTION_VERBS = 'create|make|write|save|generate|build|add|new|update|edit|install|put|set';
const FILE_THINGS = 'file|folder|directory|project|code|script|config|\\.json|app|readme|package\\.json|website|html|css';
const INFO_ASK = /^(how|what|why|when|where|which)\b/i;
const FILE_REQUEST = new RegExp(`\\b(${ACTION_VERBS})\\b[^.!?]{0,80}\\b(${FILE_THINGS})\\b`, 'i');

const STORY_WORDS = [
  'story', 'stories', 'tale', 'tales', 'legend', 'legends',
  'myth', 'myths', 'fable', 'fables', 'folklore', 'folktale',
  'folk tale', 'fairytale', 'fairy tale',
].join('|');
const STORY_LINKS = 'about|of|regarding|recounting|called|named';
const TRIM_TAIL = '\\s+(?:and|in|into)\\b|\\s*[.!?]|$';

const STORY_SUBJECT_PATTERN = new RegExp(
  `\\b(?:${STORY_WORDS})\\s+(?:${STORY_LINKS})\\s+[a-z0-9]{3,}`, 'i',
);
const STORY_ASK_PATTERN = new RegExp(
  `\\b(?:tell|write|narrate|recite|make|create|generate|give|share|hear|listen to)\\b[^.!?\\n]{0,60}\\b(?:${STORY_WORDS})\\b`, 'i',
);
const STORY_CAPTURE = new RegExp(
  `\\b(?:${STORY_WORDS})\\s+(?:${STORY_LINKS})\\s+([^.!?\\n]{2,}?)\\s*(?=${TRIM_TAIL})`, 'i',
);
const ABOUT_CAPTURE = /\b(?:tell me|talk|read|learn|research|hear|know|find out|look up|speak|write|give)\b[^.!?\n]{0,30}\babout\s+([^.!?\n]{2,}?)\s*(?=\s+(?:and|in|into)\b|\s*[.!?]|$)/i;
const PLACE_PATTERN = /\bfrom\s+[a-z][a-z\s'.-]{1,40}$/i;

const GREETINGS = new Set([
  'hi', 'hello', 'hey', 'hii', 'heyy', 'howdy', 'yo', 'hai',
  'halo', 'hallo', 'hola', 'hiya', 'sup', 'good morning',
  'good afternoon', 'good evening', 'good night', 'selamat pagi',
  'selamat siang', 'selamat sore', 'selamat malam', 'assalamualaikum',
]);

export function looksLikeStoryRequest(text) {
  return STORY_ASK_PATTERN.test(text) || STORY_SUBJECT_PATTERN.test(text);
}

export function extractSearchTopic(text) {
  const s = String(text).trim();
  const story = STORY_CAPTURE.exec(s);
  if (story) return story[1].trim();
  const about = ABOUT_CAPTURE.exec(s);
  return about ? about[1].trim() : null;
}

export function detectIntent(text) {
  const lower = text.toLowerCase().trim();
  if (lower.startsWith('/')) return { type: 'command' };

  if (GREETINGS.has(lower)) {
    return { type: 'greeting' };
  }

  if (SELF_PHRASES.some((p) => lower.includes(p))) {
    return { type: 'self' };
  }

  if (STORY_SUBJECT_PATTERN.test(lower) || PLACE_PATTERN.test(lower)) {
    return { type: 'knowledge' };
  }

  const isKnowledgePrefixed = KNOWLEDGE_PREFIXES.some(
    (p) => lower.startsWith(p + ' ') || lower === p,
  );

  if (!INFO_ASK.test(lower) && !isKnowledgePrefixed && FILE_REQUEST.test(lower)) {
    return { type: 'chat' };
  }

  const isQuestion = /\?$/.test(lower);
  const firstWord = lower.split(/\s+/)[0] || '';

  let needsWeb = false;
  if (isQuestion && QUESTION_PREFIXES.includes(firstWord)) {
    needsWeb = true;
  }
  if (isKnowledgePrefixed) {
    needsWeb = true;
  }

  return { type: needsWeb ? 'knowledge' : 'chat' };
}
