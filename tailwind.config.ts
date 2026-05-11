import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          charcoal: '#5d5d5d',
          'charcoal-dark': '#4a4a4a',
          'charcoal-deep': '#3d3d3d',
          'charcoal-deeper': '#2d2d2d',
          'rose-gold': '#c49f8c',
          'rose-gold-light': '#d4b5a6',
          beige: '#a18d89',
          cream: '#f5f0ed',
          dark: '#1a1a1a',
        },
      },
      fontFamily: {
        display: ['Derringer Serial', 'Georgia', 'serif'],
        body: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
}

export default config
