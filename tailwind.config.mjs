/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        background: '#0a090f',
        cardDark: '#13111c',
        neonPurple: '#a855f7',
        neonCyan: '#06b6d4',
        neonPink: '#ec4899',
      },
      boxShadow: {
        'glow-purple': '0 0 20px rgba(168, 85, 247, 0.4)',
        'glow-cyan': '0 0 20px rgba(6, 182, 212, 0.4)',
      },
    },
  },
  plugins: [],
};
