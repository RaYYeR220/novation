import Link from 'next/link';
import { Lamp } from '@/components/ui/lamp';

/** Holds a section's place until its view ships, and points back to the one that works. */
export function SectionPending({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-s4 py-s7 sm:px-s6">
      <div className="grid max-w-[560px] gap-s3">
        <h2 className="flex items-center gap-s3 font-display text-[28px] leading-tight font-normal text-navy-50">
          <Lamp tone="navy-400" state="ring" size={8} />
          {title}
        </h2>
        <p className="text-t15 text-navy-200">{body}</p>
        <p className="text-t15">
          <Link
            href="/app/trade"
            className="rounded-[2px] text-navy-50 underline decoration-navy-400 underline-offset-4 transition-colors duration-(--duration-fast) ui-hover:decoration-cyan"
          >
            Open Trade
          </Link>
        </p>
      </div>
    </div>
  );
}
