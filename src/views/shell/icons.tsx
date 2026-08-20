/**
 * The icon set.
 *
 * Every icon is a hand-written inline SVG on a 16×16 grid drawn with
 * `currentColor`, so icons inherit the colour of the control they sit in and
 * the app ships no icon font, no sprite sheet and no network request. They are
 * decoration: each one is `aria-hidden`, and the control around it carries the
 * accessible name.
 */

import type { ReactNode } from 'react';

export interface IconProps {
  /** Square size in pixels. Defaults to 16. */
  size?: number;
  className?: string;
}

function Svg({
  size = 16,
  className,
  children,
}: IconProps & { children: ReactNode }): ReactNode {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function FetchIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M8 2v7" />
      <path d="M5 6.5 8 9.5l3-3" />
      <path d="M2.5 11.5v1a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1" />
    </Svg>
  );
}

export function PullIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M8 2.5v8" />
      <path d="M4.5 7 8 10.5 11.5 7" />
      <path d="M3 13.5h10" />
    </Svg>
  );
}

export function PushIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M8 13.5v-8" />
      <path d="M4.5 9 8 5.5 11.5 9" />
      <path d="M3 2.5h10" />
    </Svg>
  );
}

export function BranchIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <circle cx="4.5" cy="3.5" r="1.75" />
      <circle cx="4.5" cy="12.5" r="1.75" />
      <circle cx="11.5" cy="5" r="1.75" />
      <path d="M4.5 5.25v5.5" />
      <path d="M11.5 6.75c0 2.5-2 3.5-4.25 3.75" />
    </Svg>
  );
}

export function StashIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <rect x="2.5" y="2.5" width="11" height="4" rx="1" />
      <path d="M3.5 6.5v6a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-6" />
      <path d="M6.5 9.5h3" />
    </Svg>
  );
}

export function TagIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M2.5 7.4V3a.5.5 0 0 1 .5-.5h4.4a1 1 0 0 1 .7.3l5.1 5.1a1 1 0 0 1 0 1.4l-4.1 4.1a1 1 0 0 1-1.4 0L2.8 8.3a1 1 0 0 1-.3-.9Z" />
      <circle cx="5.5" cy="5.5" r=".9" />
    </Svg>
  );
}

export function RepoIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M3.5 2.5h8a1 1 0 0 1 1 1v10H4.5a1 1 0 0 1-1-1Z" />
      <path d="M3.5 11.5h9" />
    </Svg>
  );
}

export function StageIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5.5 8h5" />
      <path d="M8 5.5v5" />
    </Svg>
  );
}

export function FileIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M9 1.75H4.5a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.25Z" />
      <path d="M9 1.75v3.5h3.5" />
    </Svg>
  );
}

export function SettingsIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="2.25" />
      <path d="M8 1.75v1.6M8 12.65v1.6M14.25 8h-1.6M3.35 8h-1.6M12.42 3.58l-1.13 1.13M4.71 11.29l-1.13 1.13M12.42 12.42l-1.13-1.13M4.71 4.71 3.58 3.58" />
    </Svg>
  );
}

export function RefreshIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M13.25 8a5.25 5.25 0 1 1-1.6-3.77" />
      <path d="M13.5 2.5v3h-3" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </Svg>
  );
}

export function ChevronRightIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="m6 3.5 5 4.5-5 4.5" />
    </Svg>
  );
}

export function ChevronDownIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="m3.5 6 4.5 5 4.5-5" />
    </Svg>
  );
}
