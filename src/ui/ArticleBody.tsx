import type { ReactNode } from 'react'

const LINK_PATTERN = /\[([^\]]+)\]\(node:(\d+)\)/g

/* Parses the [text](node:123) link syntax server/src/articles/generate.ts
 * emits — real markdown, but resolved by this light parser rather than a
 * full markdown library, since prose-with-inline-links is all article
 * content ever needs. */
export function ArticleBody({
  bodyMd,
  onSelectNode,
  className,
}: {
  bodyMd: string
  onSelectNode: (id: number) => void
  className?: string
}) {
  const parts: ReactNode[] = []
  let lastIndex = 0
  LINK_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = LINK_PATTERN.exec(bodyMd))) {
    if (match.index > lastIndex) parts.push(bodyMd.slice(lastIndex, match.index))
    const [full, text, idStr] = match
    parts.push(
      <button
        key={match.index}
        type="button"
        onClick={() => onSelectNode(Number(idStr))}
        className="text-[var(--color-ink)] hover:text-[var(--color-muted)]"
      >
        {text}
      </button>,
    )
    lastIndex = match.index + full.length
  }
  if (lastIndex < bodyMd.length) parts.push(bodyMd.slice(lastIndex))

  return <p className={className}>{parts}</p>
}
