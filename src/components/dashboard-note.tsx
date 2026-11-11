import { memo, useId } from 'react';
import { useTranslation } from 'react-i18next';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { openUrl } from '@tauri-apps/plugin-opener';
import { toast } from 'sonner';
import type { DashboardNoteWidget } from '@/lib/dashboard-config';
import './dashboard-note.css';

function noteUrl(url: string, key: string): string {
  if (key === 'href' && url.startsWith('#')) return url;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', ...(key === 'href' ? ['mailto:'] : [])].includes(parsed.protocol) ? parsed.href : '';
  } catch { return ''; }
}

export const DashboardNote = memo(function DashboardNote({ widget }: { widget: DashboardNoteWidget }) {
  const { t } = useTranslation();
  const prefix = useId();
  if (widget.format === 'text') return <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{widget.content}</div>;
  return <div className="dashboard-note text-sm leading-relaxed">
    <Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={noteUrl} remarkRehypeOptions={{ clobberPrefix: `${prefix}-`, footnoteLabel: t('dashboard.notes.footnotes'), footnoteBackLabel: t('dashboard.notes.backToContent') }} components={{
      h2: ({ node: _node, id, ...props }) => <h2 {...props} id={id === 'footnote-label' ? `${prefix}-footnote-label` : id} />,
      a: ({ href, children, title, id, 'aria-describedby': description, 'aria-label': label }) => href ? <a href={href} title={title} id={id} aria-label={label} aria-describedby={description === 'footnote-label' ? `${prefix}-footnote-label` : description} rel="noreferrer" onClick={event => {
        event.preventDefault();
        if (href.startsWith('#')) {
          try { document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ block: 'nearest' }); } catch { /* Invalid fragment. */ }
          return;
        }
        void openUrl(href).catch(() => toast.error(t('dashboard.notes.linkError')));
      }}>{children}</a> : <span>{children}</span>,
      img: ({ src, alt, title }) => src ? <img src={src} alt={alt ?? ''} title={title} loading="lazy" referrerPolicy="no-referrer" /> : <span>{alt}</span>,
      table: ({ children }) => <div className="overflow-auto"><table>{children}</table></div>,
    }}>{widget.content}</Markdown>
  </div>;
});
