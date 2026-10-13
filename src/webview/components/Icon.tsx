const PATHS = {
  server: 'M3 4h18v6H3zM3 14h18v6H3zM7 7h.01M7 17h.01',
  database: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  table: 'M3 5h18v14H3zM3 10h18M9 10v9M15 10v9',
  view: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  column: 'M4 6h16M4 12h10M4 18h6',
  key: 'M15 7a4 4 0 11-3.9 4.9L3 20v-3l2-2v-2h2l2.1-2.1A4 4 0 0115 7zM16 9h.01',
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
  plug: 'M9 2v6M15 2v6M6 8h12v3a6 6 0 01-12 0zM12 17v5',
  unplug: 'M4 4l16 16M9 2v6M15 2v4M6 8h4M14 8h4v3a6 6 0 01-1 3.3M12 17v5M6 8v3a6 6 0 008.5 5.5',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  play: 'M7 4l13 8-13 8z',
  stop: 'M6 6h12v12H6z',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  columns: 'M4 4h5v16H4zM10 4h4v16h-4zM15 4h5v16h-5z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  graph: 'M6 7a2 2 0 100-4 2 2 0 000 4zM18 9a3 3 0 100-6 3 3 0 000 6zM12 21a3 3 0 100-6 3 3 0 000 6zM7.5 6.5l3.5 9M16 8l-3 7.5M8 5h7',
  schema: 'M3 3h7v5H3zM14 16h7v5h-7zM14 3h7v5h-7zM6.5 8v5.5H17.5V16M17.5 8v0',
  builder: 'M4 5h6v6H4zM14 13h6v6h-6zM10 8h4v8',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  info: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v5M12 8h.01',
  warn: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  check: 'M5 12l5 5 9-10',
  arrowUp: 'M12 19V5M5 12l7-7 7 7',
  arrowDown: 'M12 5v14M5 12l7 7 7-7',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  collapse: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  focus: 'M12 9a3 3 0 100 6 3 3 0 000-6zM12 2v4M12 18v4M2 12h4M18 12h4',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 018 0v3',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  history: 'M3 12a9 9 0 103-6.7M3 4v5h5M12 7v5l3 3',
  logs: 'M4 6h16M4 10h16M4 14h10M4 18h7',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 14, className, title }: { name: IconName; size?: number; className?: string; title?: string }) {
  return (
    <svg
      className={`icon ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}

export function IconButton({
  icon,
  label,
  onClick,
  disabled,
  active,
  className,
  size,
}: {
  icon: IconName;
  label: string;
  onClick?: (e: React.MouseEvent) => void;
  disabled?: boolean;
  active?: boolean;
  className?: string;
  size?: number;
}) {
  return (
    <button
      type="button"
      className={`icon-btn ${active ? 'active' : ''} ${className ?? ''}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}
