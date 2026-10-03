import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://twittertools.com',
  // canonical URLs end with "/" (Base.astro builds them that way and Apache's
  // DirectorySlash 301s the bare form) — make dev enforce it too so a new
  // unslashed link fails loudly instead of costing a redirect hop
  trailingSlash: 'always',
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
});
