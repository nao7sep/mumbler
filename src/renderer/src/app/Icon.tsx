import type { ReactElement, SVGProps } from "react";

/**
 * Inline single-color icons drawn with `currentColor` so they inherit the
 * surrounding text color exactly. These replace Unicode glyphs (☰) that
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
