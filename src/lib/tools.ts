export type ToolCategory = 'download' | 'read' | 'write' | 'dev';

export interface Tool {
  slug: string;
  name: string;
  tagline: string;
  category: ToolCategory;
  /** Simple line-art SVG (24x24, stroke-based) */
  icon: string;
}

export const CATEGORY_LABELS: Record<ToolCategory, { title: string; blurb: string }> = {
  download: { title: 'Download Tools', blurb: 'Save videos, GIFs and photos from public posts.' },
  read: { title: 'Reader & Research', blurb: 'Unroll threads and build advanced X searches without learning operators.' },
  write: { title: 'Writing', blurb: 'Get the character count right before you post.' },
  dev: { title: 'Developer', blurb: 'Parse post URLs and Snowflake IDs by hand.' },
};

const svg = (inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

export const TOOLS: Tool[] = [
  {
    slug: '/twitter-video-downloader',
    name: 'X Video Downloader',
    tagline: 'Download videos and GIFs from any public post as MP4.',
    category: 'download',
    icon: svg('<path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M5 8V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-3" /><path d="M3 12h8" /><path d="m8 9 3 3-3 3" />'),
  },
  {
    slug: '/twitter-image-downloader',
    name: 'X Image Downloader',
    tagline: 'Grab full-resolution photos from posts, one or all at once.',
    category: 'download',
    icon: svg('<rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-4.35-4.35a1 1 0 0 0-1.4 0L7 19" />'),
  },
  {
    slug: '/twitter-thread-reader',
    name: 'Thread Reader',
    tagline: 'Unroll a thread into one clean page. Export to Markdown, TXT or HTML.',
    category: 'read',
    icon: svg('<path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" />'),
  },
  {
    slug: '/twitter-advanced-search-builder',
    name: 'Advanced Search Builder',
    tagline: 'Build X search queries with a form — no operators to memorize.',
    category: 'read',
    icon: svg('<circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /><path d="M11 8v6" /><path d="M8 11h6" />'),
  },
  {
    slug: '/tweet-character-counter',
    name: 'Character Counter',
    tagline: 'Count characters the way X does: CJK, emoji and links included.',
    category: 'write',
    icon: svg('<circle cx="12" cy="12" r="9" /><path d="M8 12h8" /><path d="M12 8v8" />'),
  },
  {
    slug: '/tweet-url-parser',
    name: 'URL & ID Parser',
    tagline: 'Turn a post URL into its ID, author, date — and back.',
    category: 'dev',
    icon: svg('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />'),
  },
];

export const toolsByCategory = (category: ToolCategory): Tool[] =>
  TOOLS.filter((t) => t.category === category);
