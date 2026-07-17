export const FLASH_TRANSACTION = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="200" height="200">
  <defs>
    <mask id="cut">
      <rect x="0" y="0" width="100" height="100" fill="white"/>
      <path d="M58,6 L30,52 L46,52 L40,94 L72,44 L54,44 Z"
            fill="black" stroke="black" stroke-width="10" stroke-linejoin="round"/>
    </mask>
  </defs>

  <!-- Ring with the bolt area cut out, leaving a gap -->
  <circle cx="50" cy="50" r="32" fill="none" stroke="#000000" stroke-width="9" mask="url(#cut)"/>

  <!-- White border behind the bolt -->
  <path d="M58,6 L30,52 L46,52 L40,94 L72,44 L54,44 Z"
        fill="#FFFFFF" stroke="#FFFFFF" stroke-width="4" stroke-linejoin="round"/>

  <!-- Bolt on top, crisp edges -->
  <path d="M58,6 L30,52 L46,52 L40,94 L72,44 L54,44 Z" fill="#000000"/>
</svg>
`;
