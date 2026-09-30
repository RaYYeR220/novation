import Image from 'next/image';
import type { Session } from '@/lib/client/types';
import meta from './poster-meta.json';

/** Pre-rendered stills of the crown at its rest pose (scripts/render-poster.ts). */
export const POSTER = meta as { width: number; height: number; sessions: Partial<Record<Session, string>> };

export function posterSrc(session: Session): string {
  return POSTER.sessions[session] ?? (POSTER.sessions.REGULAR as string);
}

export interface CrownPosterProps {
  session: Session;
  /** Preload it: the hero shows it on first paint. */
  priority?: boolean;
  className?: string;
  gone?: boolean;
  sizes?: string;
}

/** The crown as a still image: first paint, no WebGL, save-data and small screens. */
export function CrownPoster({ session, priority = false, className, gone = false, sizes = '(max-width: 480px) 100vw, 960px' }: CrownPosterProps) {
  return (
    <div className={className} data-gone={gone} aria-hidden="true">
      <Image
        src={posterSrc(session)}
        alt=""
        fill
        sizes={sizes}
        preload={priority}
        fetchPriority={priority ? 'high' : undefined}
        draggable={false}
      />
    </div>
  );
}
