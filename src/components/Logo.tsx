interface LogoProps {
  className?: string
  iconOnly?: boolean
}

export function Logo({ className = '', iconOnly = false }: LogoProps) {
  const viewBox = iconOnly ? '0 0 24 24' : '0 0 180 36'
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={viewBox}
      fill="none"
      role="img"
      aria-label="Plannen"
      className={className}
    >
      <defs>
        <clipPath id="plannenLogoBody">
          <rect x="3" y="6" width="15" height="14" rx="2" />
        </clipPath>
      </defs>
      <g transform={iconOnly ? undefined : 'translate(2 6)'}>
        <rect x="6.5" y="3.5" width="1.5" height="4" rx="0.6" fill="#2A9D8F" />
        <rect x="13.5" y="3.5" width="1.5" height="4" rx="0.6" fill="#2A9D8F" />
        <rect x="3" y="6" width="15" height="4.5" fill="#2A9D8F" clipPath="url(#plannenLogoBody)" />
        <rect x="3" y="6" width="15" height="14" rx="2" stroke="#2A9D8F" strokeWidth="1.5" />
        <circle cx="10.5" cy="15.5" r="1.4" fill="#2A9D8F" />
        <path d="M20 3 L20.8 4.7 L22.5 5.5 L20.8 6.3 L20 8 L19.2 6.3 L17.5 5.5 L19.2 4.7 Z" fill="#2A9D8F" />
      </g>
      {!iconOnly && (
        <text
          x="36"
          y="25"
          fontFamily="system-ui, -apple-system, 'Inter', 'Segoe UI', Roboto, sans-serif"
          fontSize="22"
          fontWeight="600"
          fill="currentColor"
          letterSpacing="-0.5"
        >
          Plannen
        </text>
      )}
    </svg>
  )
}
