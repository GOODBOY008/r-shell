import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import english from './content/i18n/en.json';
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';

// Require every custom English UI key in both language catalogs during the build.
const requiredMessages = Object.fromEntries(
  Object.keys(english).map(key => [key, z.string().min(1)]),
) as Record<keyof typeof english, z.ZodString>;

export const collections = {
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema({ extend: z.object(requiredMessages) }) }),
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
