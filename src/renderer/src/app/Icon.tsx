import type { ReactElement, SVGProps } from "react";

/**
 * Inline single-color icons drawn with `currentColor` so they inherit the
 * surrounding text color exactly. These replace Unicode glyphs (☰ ✕ ↗) that
 * rendered with uneven stroke weight and anti-alias artifacts across fonts and
 * sizes. Each icon is decorative (`aria-hidden`); the owning control carries
 * the accessible name.
 */

type IconProps = Omit<SVGProps<SVGSVGElement>, "children">;

function IconBase({ children, ...props }: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function HamburgerIcon(props: IconProps): ReactElement {
  return (
    <IconBase {...props}>
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
    </IconBase>
  );
}

export function CloseIcon(props: IconProps): ReactElement {
  return (
    <IconBase {...props}>
      <path d="M18.92 4.30L5.08 19.00" />
      <path d="M5.08 4.30L18.92 19.00" />
    </IconBase>
  );
}

export function ExternalLinkIcon(props: IconProps): ReactElement {
  return (
    <IconBase {...props}>
      <path d="M15.90 12.50L15.90 19.00L5.50 19.00L5.50 8.60L12.00 8.60" />
      <path d="M13.30 5.57L18.50 5.57L18.50 10.77" />
      <path d="M18.50 5.57L11.13 12.93" />
    </IconBase>
  );
}
