// A person's face beside their login: the forge avatar when the forge reported one,
// else their initials on a raised ground. The image is decorative — the login is
// always printed beside it — so a broken or missing picture degrades to initials
// without an alt-text stutter. No new primitive: a plain `img` with a fallback.

import { cn } from "@rennet/ui";
import { useState } from "react";

/** Up to two initials from a login or display name (`rbutera` → R, `Rai Butera` → RB). */
export function initialsOf(name: string): string {
  const words = name
    .split(/[\s._-]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
  if (words.length === 0) return "?";
  if (words.length === 1) return (words[0] ?? "").charAt(0).toUpperCase();
  return `${words[0]?.charAt(0) ?? ""}${words[words.length - 1]?.charAt(0) ?? ""}`.toUpperCase();
}

export function Avatar({
  name,
  src,
  className,
}: {
  readonly name: string;
  readonly src?: string | undefined;
  readonly className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = src !== undefined && !failed;
  return (
    <span
      data-avatar={showImage ? "image" : "initials"}
      className={cn(
        "inline-flex size-5 shrink-0 select-none items-center justify-center overflow-hidden rounded-full border border-line bg-raised align-middle font-medium text-2xs text-ink-soft",
        className,
      )}
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      ) : (
        initialsOf(name)
      )}
    </span>
  );
}
