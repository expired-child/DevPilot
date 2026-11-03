import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

/** 统一侧栏图标：线性 SVG，尺寸与颜色跟随上下文。 */
function Icon({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
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

export const SearchIcon = (props: IconProps) => (
  <Icon {...props}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.4-3.4" /></Icon>
);

export const BackIcon = (props: IconProps) => (
  <Icon {...props}><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></Icon>
);

export const CloseIcon = (props: IconProps) => (
  <Icon {...props}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Icon>
);

export const RefreshIcon = (props: IconProps) => (
  <Icon {...props}><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></Icon>
);

export const ChevronRightIcon = (props: IconProps) => (
  <Icon {...props}><path d="m9 18 6-6-6-6" /></Icon>
);
